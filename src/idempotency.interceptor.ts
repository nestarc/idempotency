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
  IdempotencyScope,
  IdempotentMetadata,
} from './interfaces/idempotency-options.interface';
import type {
  IdempotencyRecord,
} from './interfaces/idempotency-record.interface';
import type { IdempotencyStorage } from './interfaces/idempotency-storage.interface';

interface ResolvedOptions {
  required: boolean;
  ttl: number;
  fingerprint: boolean;
  headerName: string;
  scope: IdempotencyScope;
}

/**
 * The minimal shape of the response object the interceptor touches.
 * Matches both Express's `Response` and Fastify's `FastifyReply` signatures
 * for the two operations we actually use: reading the effective statusCode
 * and setting it for a replay.
 */
interface ResponseShape {
  statusCode?: number;
  status: (code: number) => unknown;
}

/**
 * The core idempotency interceptor.
 *
 * Reads `@Idempotent()` metadata off the handler, extracts the configured
 * idempotency header, computes a request body fingerprint, and dispatches
 * the storage state machine: replay COMPLETED, conflict on PROCESSING,
 * mismatch on differing fingerprint, otherwise lock + delegate + capture
 * response under token-based compare-and-set.
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

  // ──────────────────────────────────────────────────────────────────
  // intercept() is the entry point. Its body reads as a narrative:
  //   1. Read decorator metadata and bail if not idempotent-enabled.
  //   2. Extract the Idempotency-Key header (and scope it).
  //   3. Look up the existing record and dispatch to `handleExisting` if
  //      one was found, or `acquireAndRun` otherwise.
  // Each branch is a private method so this body stays readable and the
  // RxJS pipeline is not nested four levels deep.
  // ──────────────────────────────────────────────────────────────────
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
    const res = http.getResponse<ResponseShape>();

    const headerValue = req.headers[opts.headerName.toLowerCase()];
    const rawKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!rawKey) {
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

    const scopedKey = this.applyScope(opts.scope, context, rawKey);
    const fingerprint = opts.fingerprint
      ? this.computeFingerprint(req.body)
      : undefined;

    return from(this.storage.get(scopedKey)).pipe(
      switchMap((existing) => {
        if (existing) {
          return this.handleExistingRecord(existing, fingerprint, res);
        }
        return this.acquireAndRun(scopedKey, fingerprint, opts, res, next);
      }),
    );
  }

  /**
   * Dispatches a request that observed an EXISTING storage record.
   *
   * Three outcomes, in priority order:
   * - Fingerprint mismatch → 422 (beats PROCESSING even while in-flight)
   * - Status is PROCESSING → 409
   * - Status is COMPLETED → replay (restore statusCode, parse body)
   *
   * Extracted from {@link intercept} for SRP — the rules governing
   * "what to do with a record that already exists" change independently
   * from the rules governing "how to acquire a new lock and run".
   */
  private handleExistingRecord(
    existing: IdempotencyRecord,
    fingerprint: string | undefined,
    res: ResponseShape,
  ): Observable<unknown> {
    // Fingerprint mismatch takes priority over PROCESSING state —
    // IETF draft semantics (key reused with different payload → 422).
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

    // Status is COMPLETED — replay the cached response.
    if (typeof existing.statusCode === 'number') {
      res.status(existing.statusCode);
    }
    const body =
      existing.responseBody !== undefined
        ? JSON.parse(existing.responseBody)
        : undefined;
    return of(body);
  }

  /**
   * Acquires a new PROCESSING lock, runs the downstream handler, and
   * captures its response (or cleans up on error).
   *
   * Extracted from {@link intercept} for SRP — the lock-acquisition /
   * delegate / cleanup lifecycle is a self-contained responsibility
   * separate from the "existing record" dispatch above.
   */
  private acquireAndRun(
    scopedKey: string,
    fingerprint: string | undefined,
    opts: ResolvedOptions,
    res: ResponseShape,
    next: CallHandler,
  ): Observable<unknown> {
    return from(this.storage.create(scopedKey, fingerprint, opts.ttl)).pipe(
      switchMap((createResult) => {
        if (!createResult.acquired || !createResult.token) {
          return throwError(
            () =>
              new ConflictException(
                `Request with this Idempotency-Key is already being processed`,
              ),
          );
        }
        const token = createResult.token;

        return next.handle().pipe(
          concatMap((value) =>
            this.captureResponse(scopedKey, token, value, res, opts.ttl),
          ),
          catchError((err) =>
            from(this.storage.delete(scopedKey, token)).pipe(
              switchMap(() => throwError(() => err)),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Captures the handler's emitted value into storage, handling all the
   * corner cases that would otherwise clutter the main pipeline:
   *
   * - Non-replayable types (Buffer, streams) → bypass cache + warn
   * - JSON serialization failure (circular refs) → bypass cache + warn
   * - Storage complete() returns 'stale' → emit anyway + warn
   * - Otherwise → persist and emit the original value
   *
   * This is the "response capture" responsibility, which changes for
   * different reasons than lock acquisition or state dispatch — so it
   * lives in its own method.
   */
  private captureResponse(
    scopedKey: string,
    token: string,
    value: unknown,
    res: ResponseShape,
    ttl: number,
  ): Observable<unknown> {
    // Guard #1: non-replayable response types (Buffer, streams, etc.)
    if (!IdempotencyInterceptor.isReplayable(value)) {
      this.logger.warn(
        `Response for key="${scopedKey}" is not a plain JSON value (type=${IdempotencyInterceptor.describeType(value)}); skipping cache`,
      );
      return from(this.storage.delete(scopedKey, token)).pipe(
        map(() => value),
      );
    }

    // Guard #2: JSON serialization failure (circular refs, BigInt, etc.)
    let serialized: string | undefined;
    try {
      serialized =
        value === undefined ? undefined : JSON.stringify(value);
    } catch (err) {
      this.logger.warn(
        `Response for key="${scopedKey}" is not JSON-serializable; skipping cache (${(err as Error).message})`,
      );
      return from(this.storage.delete(scopedKey, token)).pipe(
        map(() => value),
      );
    }

    const statusCode = res.statusCode ?? 200;
    return from(
      this.storage.complete(
        scopedKey,
        token,
        { statusCode, body: serialized },
        ttl,
      ),
    ).pipe(
      map((result) => {
        if (result === 'stale') {
          // Our record was evicted and replaced while the handler ran.
          // The client deserves the response we computed; we just
          // can't cache it. Log and emit.
          this.logger.warn(
            `Stale token when completing key="${scopedKey}" — response not cached (likely TTL eviction race)`,
          );
        }
        return value;
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
      scope: this.moduleOptions.scope ?? 'endpoint',
    };
  }

  /**
   * Derives the namespaced storage key from the raw header value according
   * to the configured {@link IdempotencyScope}.
   */
  private applyScope(
    scope: IdempotencyScope,
    context: ExecutionContext,
    rawKey: string,
  ): string {
    if (scope === 'global') {
      return rawKey;
    }
    if (typeof scope === 'function') {
      return `${scope(context)}::${rawKey}`;
    }
    // 'endpoint' — Controller class name + handler method name.
    // `::` cannot appear in JS identifiers so there is no collision risk.
    const className = context.getClass()?.name ?? 'UnknownController';
    const methodName = context.getHandler()?.name ?? 'unknownHandler';
    return `${className}#${methodName}::${rawKey}`;
  }

  private computeFingerprint(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  /**
   * True if the value is a plain JSON-replayable shape: null, undefined,
   * primitives, plain objects, and arrays. False for Buffers, typed arrays,
   * ArrayBuffers, Node streams, and Web ReadableStreams — those will not
   * round-trip correctly through JSON.parse(JSON.stringify(...)).
   */
  private static isReplayable(value: unknown): boolean {
    if (value === null || value === undefined) {
      return true;
    }
    if (typeof value !== 'object') {
      return true;
    }
    if (Buffer.isBuffer(value)) {
      return false;
    }
    if (ArrayBuffer.isView(value)) {
      return false;
    }
    if (value instanceof ArrayBuffer) {
      return false;
    }
    const maybeStream = value as { pipe?: unknown; getReader?: unknown };
    if (typeof maybeStream.pipe === 'function') {
      return false;
    }
    if (typeof maybeStream.getReader === 'function') {
      return false;
    }
    return true;
  }

  private static describeType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Buffer.isBuffer(value)) return 'Buffer';
    if (ArrayBuffer.isView(value)) return value.constructor.name;
    if (value instanceof ArrayBuffer) return 'ArrayBuffer';
    const maybeStream = value as { pipe?: unknown; getReader?: unknown };
    if (typeof maybeStream.pipe === 'function') return 'Stream';
    if (typeof maybeStream.getReader === 'function') return 'ReadableStream';
    return typeof value;
  }
}
