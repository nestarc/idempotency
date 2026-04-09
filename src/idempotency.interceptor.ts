import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import {
  catchError,
  concatMap,
  from,
  map,
  Observable,
  of,
  switchMap,
  throwError,
} from 'rxjs';

import {
  DEFAULT_HEADER_NAME,
  DEFAULT_TTL_SECONDS,
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
  IDEMPOTENT_METADATA_KEY,
} from './idempotency.constants';
import type {
  IdempotencyOptions,
  IdempotentMetadata,
} from './interfaces/idempotency-options.interface';
import type { IdempotencyStorage } from './interfaces/idempotency-storage.interface';

interface ResolvedOptions {
  required: boolean;
  ttl: number;
  fingerprint: boolean;
  headerName: string;
}

/**
 * The core idempotency interceptor.
 *
 * Reads `@Idempotent()` metadata off the handler, extracts the configured
 * idempotency header, computes a request body fingerprint, and dispatches the
 * storage state machine: replay COMPLETED, conflict on PROCESSING, mismatch
 * on differing fingerprint, otherwise lock + delegate + capture response.
 *
 * Implements the IETF draft `httpapi-idempotency-key-header-07` semantics for
 * 400 / 409 / 422 responses.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_STORAGE) private readonly storage: IdempotencyStorage,
    @Inject(IDEMPOTENCY_OPTIONS)
    private readonly moduleOptions: IdempotencyOptions,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const metadata = this.reflector.get<IdempotentMetadata | undefined>(
      IDEMPOTENT_METADATA_KEY,
      context.getHandler(),
    );

    // No decorator, or explicit escape hatch — pass through untouched.
    if (!metadata || metadata.enabled !== true) {
      return next.handle();
    }

    const opts = this.resolveOptions(metadata);
    const http = context.switchToHttp();
    const req = http.getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
    }>();
    const res = http.getResponse<{ statusCode?: number; status: (code: number) => unknown }>();

    const headerValue = req.headers[opts.headerName.toLowerCase()];
    const key = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!key) {
      if (opts.required) {
        return throwError(
          () =>
            new BadRequestException(
              `${opts.headerName} header is required for this endpoint`,
            ),
        );
      }
      return next.handle();
    }

    const fingerprint = opts.fingerprint
      ? this.computeFingerprint(req.body)
      : undefined;

    return from(this.storage.get(key)).pipe(
      switchMap((existing) => {
        if (existing) {
          // Fingerprint mismatch wins over PROCESSING — IETF draft semantics.
          if (
            existing.fingerprint &&
            fingerprint &&
            existing.fingerprint !== fingerprint
          ) {
            return throwError(
              () =>
                new UnprocessableEntityException(
                  `Idempotency-Key reused with a different payload`,
                ),
            );
          }

          if (existing.status === 'PROCESSING') {
            return throwError(
              () =>
                new ConflictException(
                  `Request with this Idempotency-Key is already being processed`,
                ),
            );
          }

          if (existing.status === 'COMPLETED') {
            if (typeof existing.statusCode === 'number') {
              res.status(existing.statusCode);
            }
            const body =
              existing.responseBody !== undefined
                ? JSON.parse(existing.responseBody)
                : undefined;
            return of(body);
          }
        }

        // No existing record — try to acquire the lock.
        return from(this.storage.create(key, fingerprint, opts.ttl)).pipe(
          switchMap((created) => {
            if (!created) {
              return throwError(
                () =>
                  new ConflictException(
                    `Request with this Idempotency-Key is already being processed`,
                  ),
              );
            }
            return next.handle().pipe(
              concatMap((value) => {
                let serialized: string | undefined;
                try {
                  serialized =
                    value === undefined ? undefined : JSON.stringify(value);
                } catch (err) {
                  this.logger.warn(
                    `Response for key="${key}" is not JSON-serializable; skipping cache (${(err as Error).message})`,
                  );
                  return from(this.storage.delete(key)).pipe(map(() => value));
                }
                const statusCode = res.statusCode ?? 200;
                return from(
                  this.storage.complete(
                    key,
                    { statusCode, body: serialized },
                    opts.ttl,
                  ),
                ).pipe(map(() => value));
              }),
              catchError((err) =>
                from(this.storage.delete(key)).pipe(
                  switchMap(() => throwError(() => err)),
                ),
              ),
            );
          }),
        );
      }),
    );
  }

  private resolveOptions(metadata: IdempotentMetadata): ResolvedOptions {
    return {
      required: metadata.required ?? true,
      ttl: metadata.ttl ?? this.moduleOptions.ttl ?? DEFAULT_TTL_SECONDS,
      fingerprint:
        metadata.fingerprint ?? this.moduleOptions.fingerprint ?? true,
      headerName: this.moduleOptions.headerName ?? DEFAULT_HEADER_NAME,
    };
  }

  private computeFingerprint(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }
}
