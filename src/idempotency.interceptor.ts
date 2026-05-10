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
import { extractActualRequestPath } from './utils/request-scope';
import {
  captureReplayHeaders,
  replayStoredHeaders,
  type HeaderCaptureResponse,
  type HeaderReplayResponse,
} from './utils/response-headers';
import { stableJsonStringify } from './utils/stable-json';
import type {
  IdempotencyOptions,
  IdempotencyScope,
  IdempotentMetadata,
  ReplayHeadersOption,
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
  replayHeaders: ReplayHeadersOption | undefined;
}

/**
 * The minimal shape of the response object the interceptor touches.
 * Matches both Express's `Response` and Fastify's `FastifyReply` signatures
 * for the two operations we actually use: reading the effective statusCode
 * and setting it for a replay.
 */
interface ResponseShape extends HeaderCaptureResponse, HeaderReplayResponse {
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

    // resolveOptions throws sync on invalid TTL — convert to an Observable
    // error so callers uniformly await rejection via firstValueFrom/subscribe.
    let opts: ResolvedOptions;
    try {
      opts = this.resolveOptions(metadata);
    } catch (err) {
      return throwError(() => err);
    }
    const http = context.switchToHttp();
    const req = http.getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
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
          return this.handleExistingRecord(existing, fingerprint, res, opts);
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
    opts: ResolvedOptions,
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
    replayStoredHeaders(res, existing.responseHeaders, opts.replayHeaders);
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
          // We lost the race — between our initial get() and this create(),
          // a concurrent request slipped in. Re-read the record to find out
          // what state it's in. If the winner already finished (COMPLETED),
          // the correct response is REPLAY (matching fingerprint) or 422
          // (mismatch). If the winner is still in-flight (PROCESSING), 409.
          // Only if the record vanished between create() and the re-read
          // (impossible in normal operation but defensive) do we fall back
          // to 409 with no better signal.
          return from(this.storage.get(scopedKey)).pipe(
            switchMap((raced) => {
              if (!raced) {
                return throwError(
                  () =>
                    new ConflictException(
                      `Request with this Idempotency-Key is already being processed`,
                    ),
                );
              }
              return this.handleExistingRecord(raced, fingerprint, res, opts);
            }),
          );
        }
        const token = createResult.token;

        return next.handle().pipe(
          concatMap((value) =>
            this.captureResponse(scopedKey, token, value, res, opts),
          ),
          catchError((err) =>
            // Handler failure ONLY — captureResponse is total and never
            // throws storage errors up to this point. Safe to delete the
            // record and re-throw the handler's exception.
            from(this.storage.delete(scopedKey, token)).pipe(
              // Even the delete is best-effort. If cleanup fails we still
              // propagate the original handler error; the record will TTL out.
              catchError((delErr) => {
                this.logger.warn(
                  `storage.delete() failed during handler-error cleanup for key="${scopedKey}": ${(delErr as Error).message}. Propagating original handler error.`,
                );
                return of(undefined);
              }),
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
   * - Storage complete() THROWS (transient failure) → emit anyway + error log,
   *   **do not delete the record**. The handler succeeded; a transient write
   *   failure must not turn a successful business operation into a retryable
   *   failure for the client. The PROCESSING record stays in place until
   *   TTL reclaims it; retries in that window correctly hit 409.
   * - Otherwise → persist and emit the original value
   *
   * CRITICAL: this method is *total* — it never lets an exception escape.
   * The caller's `catchError` in {@link acquireAndRun} is strictly for
   * HANDLER errors; mixing in storage errors here would delete the record
   * and cause duplicate execution on retry (pre-v0.1.3 regression).
   */
  private captureResponse(
    scopedKey: string,
    token: string,
    value: unknown,
    res: ResponseShape,
    opts: ResolvedOptions,
  ): Observable<unknown> {
    // Guard #1: non-replayable response types (Buffer, streams, etc.)
    if (!IdempotencyInterceptor.isReplayable(value)) {
      this.logger.warn(
        `Response for key="${scopedKey}" is not a plain JSON value (type=${IdempotencyInterceptor.describeType(value)}); skipping cache`,
      );
      return from(this.storage.delete(scopedKey, token)).pipe(
        // Even the cleanup-delete is total — if it throws, emit the value
        // anyway. The handler already succeeded.
        catchError((err) => {
          this.logger.warn(
            `storage.delete() failed during non-replayable cleanup for key="${scopedKey}": ${(err as Error).message}. Emitting handler value anyway.`,
          );
          return of(undefined);
        }),
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
        catchError((delErr) => {
          this.logger.warn(
            `storage.delete() failed during serialization-failure cleanup for key="${scopedKey}": ${(delErr as Error).message}. Emitting handler value anyway.`,
          );
          return of(undefined);
        }),
        map(() => value),
      );
    }

    const statusCode = res.statusCode ?? 200;
    const headers = captureReplayHeaders(res, opts.replayHeaders);
    return from(
      this.storage.complete(
        scopedKey,
        token,
        { statusCode, body: serialized, headers },
        opts.ttl,
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
      // CRITICAL: swallow storage.complete() exceptions. The handler already
      // succeeded; a transient cache-write failure must not cause duplicate
      // execution on retry. The PROCESSING record stays and retries see 409
      // until TTL reclaims it — the lesser evil vs. re-running a successful
      // business operation.
      catchError((err) => {
        this.logger.error(
          `storage.complete() threw for key="${scopedKey}": ${(err as Error).message}. Handler succeeded; emitting value without cache. Retries will see 409 until TTL expires.`,
        );
        return of(value);
      }),
    );
  }

  private resolveOptions(metadata: IdempotentMetadata): ResolvedOptions {
    const ttl =
      metadata.ttl ?? this.moduleOptions.ttl ?? DEFAULT_TTL_SECONDS;
    // Guard against footguns: ttl must be a positive integer number of seconds.
    // A zero or negative TTL would produce immediately-expired records (Redis
    // in particular rejects EX <= 0), and fractional seconds round unpredictably
    // across adapters. Fail fast at the interceptor boundary so the error
    // surfaces at request time with the exact bad value.
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
      throw new Error(
        `IdempotencyInterceptor: ttl must be a positive integer number of seconds, received ${String(ttl)}`,
      );
    }
    return {
      required: metadata.required ?? true,
      ttl,
      fingerprint:
        metadata.fingerprint ?? this.moduleOptions.fingerprint ?? true,
      headerName: this.moduleOptions.headerName ?? DEFAULT_HEADER_NAME,
      scope: this.moduleOptions.scope ?? 'endpoint',
      replayHeaders: this.moduleOptions.replayHeaders ?? true,
    };
  }

  /**
   * Derives the namespaced storage key from the raw header value according
   * to the configured {@link IdempotencyScope}.
   *
   * For `scope: 'endpoint'` (the default), the interceptor first scopes by
   * the platform request's actual HTTP method + path. Express's
   * `req.originalUrl` wins, Fastify-style `req.url` is the fallback, query
   * strings are ignored, and duplicate/trailing slashes are normalized.
   *
   * If no actual request path is available, it falls back to NestJS route
   * template metadata (`PATH_METADATA` set by `@Controller` and
   * `@Get`/`@Post`/etc.) so existing non-platform test fixtures and custom
   * contexts keep stable endpoint scoping.
   *
   * If `PATH_METADATA` is unavailable (custom decorators, non-NestJS
   * controllers, or test fixtures without metadata), it falls back to the
   * legacy `ControllerClassName#methodName` scope — which is still safer
   * than no scope at all.
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
    return `${this.computeEndpointScope(context)}::${rawKey}`;
  }

  /**
   * Computes the endpoint scope prefix for a given execution context.
   * Split out of {@link applyScope} so the fallback chain is easy to read
   * and independently testable.
   */
  private computeEndpointScope(context: ExecutionContext): string {
    const controller = context.getClass();
    const handler = context.getHandler();
    const req = context.switchToHttp().getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const httpMethod = (req?.method ?? 'UNKNOWN').toUpperCase();
    const actualPath = extractActualRequestPath(req);

    if (actualPath) {
      return `${httpMethod} ${actualPath}`;
    }

    // If no platform request path is available, use Nest route metadata.
    // Both pieces of path metadata are
    // stamped by NestJS controller/method decorators — reader is safe to
    // use even when the metadata is absent (it returns undefined).
    const controllerPath = this.reflector.get<string | undefined>(
      IdempotencyInterceptor.NEST_PATH_METADATA,
      controller,
    );
    const handlerPath = this.reflector.get<string | undefined>(
      IdempotencyInterceptor.NEST_PATH_METADATA,
      handler,
    );

    if (controllerPath !== undefined && handlerPath !== undefined) {
      // Normalize slashes: collapse duplicates, ensure single leading slash.
      const joined = `/${controllerPath}/${handlerPath}`
        .replace(/\/+/g, '/')
        .replace(/\/+$/, '') || '/';
      return `${httpMethod} ${joined}`;
    }

    // Fallback: class name + method name. Not URL-accurate but isolates
    // handlers within a single controller at minimum.
    const className = controller?.name ?? 'UnknownController';
    const methodName = handler?.name ?? 'unknownHandler';
    return `${className}#${methodName}`;
  }

  /**
   * Internal NestJS metadata key used by `@Controller()` / `@Get()` / etc.
   * to stamp the route path on the target. Exposed as a private static
   * so the string literal is centralized and documented.
   */
  private static readonly NEST_PATH_METADATA = 'path';

  private computeFingerprint(body: unknown): string {
    return createHash('sha256')
      .update(stableJsonStringify(body ?? null)!)
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
