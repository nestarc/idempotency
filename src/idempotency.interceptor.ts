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
  defaultIfEmpty,
  defer,
  from,
  map,
  Observable,
  of,
  switchMap,
  takeLast,
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
import { createRequestKey, isValidKeyString } from './utils/request-key';
import { logDiagnostic } from './utils/observability';
import { decodeReplayBody, encodeReplayBody } from './utils/replay-body';
import { assertReplayableResponseMode } from './utils/response-mode';
import {
  captureReplayHeaders,
  replayStoredHeaders,
  type HeaderCaptureResponse,
  type HeaderReplayResponse,
} from './utils/response-headers';
import { stableJsonStringify } from './utils/stable-json';
import type {
  IdempotencyOptions,
  IdempotencyEvent,
  IdempotencyStorageOperation,
  IdempotencyFingerprintResolver,
  IdempotencyObservabilityOptions,
  IdempotencyOutcome,
  IdempotencyKeyResolver,
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
  processingTtl: number;
  fingerprint: boolean | IdempotencyFingerprintResolver;
  headerName: string;
  keyResolver: IdempotencyKeyResolver | undefined;
  maxKeyLength: number;
  scope: IdempotencyScope;
  replayHeaders: ReplayHeadersOption | undefined;
  observability: IdempotencyObservabilityOptions | undefined;
}

type ScopedRequestKey = ReturnType<typeof createRequestKey>;

interface RequestShape {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, unknown>;
  rawHeaders?: string[];
  raw?: { rawHeaders?: string[] };
  body: unknown;
}

/**
 * The minimal shape of the response object the interceptor touches.
 * Matches both Express's `Response` and Fastify's `FastifyReply` signatures
 * including effective status, replay headers and whether the handler has
 * already sent the response outside the return-value pipeline.
 */
interface ResponseShape extends HeaderCaptureResponse, HeaderReplayResponse {
  statusCode?: number;
  status: (code: number) => unknown;
  headersSent?: boolean;
  sent?: boolean;
  raw?: { headersSent?: boolean };
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

    // Convert configuration errors to Observable errors so callers uniformly
    // await rejection via firstValueFrom/subscribe.
    let opts: ResolvedOptions;
    try {
      opts = this.resolveOptions(metadata);
      assertReplayableResponseMode(context);
    } catch (err) {
      return throwError(() => err);
    }
    const http = context.switchToHttp();
    const req = http.getRequest<RequestShape>();
    const res = http.getResponse<ResponseShape>();

    return from(this.resolveRawKey(opts, context, req)).pipe(
      switchMap((rawKey) => {
        if (rawKey === undefined) {
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
        return from(
          this.resolveFingerprint(opts, context, rawKey, scopedKey.key, req.body),
        ).pipe(
          switchMap((fingerprint) =>
            this.observeStorage(opts, scopedKey, 'get', () => this.storage.get(scopedKey.key)).pipe(
              switchMap((existing) => {
                if (existing) {
                  return this.handleExistingRecord(
                    existing,
                    fingerprint,
                    res,
                    opts,
                    scopedKey,
                  );
                }
                return this.acquireAndRun(
                  scopedKey,
                  fingerprint,
                  opts,
                  res,
                  next,
                );
              }),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Dispatches a request that observed an EXISTING storage record.
   *
   * Outcomes, in priority order:
   * - Fingerprint mismatch → 422 (beats PROCESSING even while in-flight)
   * - Status is PROCESSING → 409
   * - Status is COMPLETED with a supported payload → replay
   * - Legacy/corrupt payload → 409 without applying its status/headers/body
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
    scopedKey: ScopedRequestKey,
  ): Observable<unknown> {
    // Fingerprint mismatch takes priority over PROCESSING state —
    // IETF draft semantics (key reused with different payload → 422).
    if (
      existing.fingerprint &&
      fingerprint &&
      existing.fingerprint !== fingerprint
    ) {
      this.setIdempotencyStatus(res, opts, 'mismatch');
      this.emitEvent(opts, 'mismatch', scopedKey, {
        statusCode: 422,
      });
      return throwError(
        () =>
          new UnprocessableEntityException(
            `Idempotency-Key reused with a different payload`,
          ),
      );
    }

    if (existing.status === 'PROCESSING') {
      this.setIdempotencyStatus(res, opts, 'conflict');
      this.emitEvent(opts, 'conflict', scopedKey, {
        statusCode: 409,
      });
      return throwError(
        () =>
          new ConflictException(
            `Request with this Idempotency-Key is already being processed`,
          ),
      );
    }

    // Old records can contain class fields omitted by the HTTP serializer.
    // A versioned payload identifies captures using the current boundary.
    // Keep unrecognized records in place rather than re-running the operation.
    const decoded = decodeReplayBody(existing.responseBody);
    if (!decoded.replayable) {
      this.setIdempotencyStatus(res, opts, 'conflict');
      this.emitEvent(opts, 'conflict', scopedKey, { statusCode: 409 });
      return throwError(
        () => new ConflictException(
          'Stored response cannot be safely replayed; reconcile the original operation before retrying',
        ),
      );
    }

    // Status is COMPLETED with a supported payload — replay the cached response.
    if (typeof existing.statusCode === 'number') {
      res.status(existing.statusCode);
    }
    replayStoredHeaders(res, existing.responseHeaders, opts.replayHeaders);
    this.setIdempotencyStatus(res, opts, 'replayed');
    if (this.shouldExposeStatusHeaders(opts)) {
      this.setHeader(res, 'Idempotency-Replayed', 'true');
    }
    this.emitEvent(opts, 'replayed', scopedKey, {
      statusCode: existing.statusCode,
    });
    return of(decoded.value);
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
    scopedKey: ScopedRequestKey,
    fingerprint: string | undefined,
    opts: ResolvedOptions,
    res: ResponseShape,
    next: CallHandler,
  ): Observable<unknown> {
    return this.observeStorage(opts, scopedKey, 'create', () =>
      this.storage.create(scopedKey.key, fingerprint, opts.processingTtl),
    ).pipe(
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
          return this.observeStorage(opts, scopedKey, 'race_get', () => this.storage.get(scopedKey.key)).pipe(
            switchMap((raced) => {
              if (!raced) {
                this.setIdempotencyStatus(res, opts, 'conflict');
                this.emitEvent(opts, 'conflict', scopedKey, {
                  statusCode: 409,
                });
                return throwError(
                  () =>
                    new ConflictException(
                      `Request with this Idempotency-Key is already being processed`,
                    ),
                );
              }
              return this.handleExistingRecord(
                raced,
                fingerprint,
                res,
                opts,
                scopedKey,
              );
            }),
          );
        }
        const token = createResult.token;

        return defer(() => next.handle()).pipe(
          // Nest's ordinary HTTP response uses the final value on completion.
          // Never expose an intermediate emission as a completed operation.
          takeLast(1),
          defaultIfEmpty(undefined),
          catchError((err) =>
            // Only source failures reach cleanup. A handler error does not
            // prove that business effects rolled back; consumers must enforce
            // their own durable command deduplication before retrying.
            this.observeStorage(opts, scopedKey, 'delete', () => this.storage.delete(scopedKey.key, token)).pipe(
              // Even the delete is best-effort. If cleanup fails we still
              // propagate the original handler error; the record will TTL out.
              catchError(() => {
                logDiagnostic(this.logger, 'cleanup_failure', this.eventContext(scopedKey));
                return of(undefined);
              }),
              switchMap(() => throwError(() => err)),
            ),
          ),
          // Keep post-success work outside the handler-error boundary. Neither
          // a capture failure nor a lost completion acknowledgement may unlock
          // an operation which already succeeded.
          concatMap((value) =>
            this.captureResponse(scopedKey, token, value, res, opts),
          ),
        );
      }),
    );
  }

  /**
   * Captures the handler's final, successfully completed value, handling the
   * corner cases that would otherwise clutter the main pipeline:
   *
   * - Unsupported shapes or already-sent responses → bypass cache + warn,
   *   retaining PROCESSING until its existing lease expires
   * - Storage complete() returns 'stale' → emit anyway + warn
   * - Storage complete() THROWS (transient failure) → emit anyway + error log,
   *   **do not delete the record**. The handler succeeded; a transient write
   *   failure must not turn a successful business operation into a retryable
   *   failure for the client. The record may be PROCESSING or already COMPLETED
   *   if the write applied but its acknowledgement was lost.
   * - Otherwise → persist and emit the original value
   *
   * Capture and storage failures preserve the successful value. Cleanup is
   * structurally upstream, so post-success exceptions cannot unlock the record.
   */
  private captureResponse(
    scopedKey: ScopedRequestKey,
    token: string,
    value: unknown,
    res: ResponseShape,
    opts: ResolvedOptions,
  ): Observable<unknown> {
    // Passthrough is supported only for status/headers plus a returned value.
    // A handler that already sent its response cannot be captured accurately.
    let alreadySent = false;
    let statusCode: number | undefined;
    let serialized: string;
    let headers: Record<string, string> | undefined;
    try {
      alreadySent = Boolean(res.headersSent || res.sent || res.raw?.headersSent);
      statusCode = res.statusCode ?? 200;
      if (alreadySent) throw new Error('HTTP response was already sent');
      serialized = encodeReplayBody(value);
      headers = captureReplayHeaders(res, opts.replayHeaders);
    } catch {
      logDiagnostic(this.logger, 'response_not_replayable', this.eventContext(scopedKey));
      if (!alreadySent) this.setIdempotencyStatus(res, opts, 'bypassed');
      this.emitEvent(opts, 'bypassed', scopedKey, {
        statusCode,
        error: { code: 'response_not_replayable' },
      });
      return of(value);
    }

    return defer(() =>
      this.storage.complete(
        scopedKey.key,
        token,
        { statusCode: statusCode!, body: serialized, headers },
        opts.ttl,
      ),
    ).pipe(
      // Catch only the storage operation, not response/event processing.
      catchError(() => {
        logDiagnostic(this.logger, 'complete_failure', this.eventContext(scopedKey));
        this.setIdempotencyStatus(res, opts, 'complete_error');
        this.emitEvent(opts, 'complete_error', scopedKey, {
          statusCode,
          error: { code: 'storage_failure', operation: 'complete' },
        });
        return of('failed' as const);
      }),
      map((result) => {
        if (result === 'stale') {
          // Our record was evicted and replaced while the handler ran.
          // The client deserves the response we computed; we just
          // can't cache it. Log and emit.
          logDiagnostic(this.logger, 'stale_completion', this.eventContext(scopedKey));
          this.setIdempotencyStatus(res, opts, 'stale');
          this.emitEvent(opts, 'stale', scopedKey, {
            statusCode,
          });
        } else if (result === 'ok') {
          this.setIdempotencyStatus(res, opts, 'created');
          this.emitEvent(opts, 'created', scopedKey, {
            statusCode,
          });
        }
        return value;
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
    const processingTtl =
      metadata.processingTtl ?? this.moduleOptions.processingTtl ?? ttl;
    if (
      typeof processingTtl !== 'number' ||
      !Number.isFinite(processingTtl) ||
      !Number.isInteger(processingTtl) ||
      processingTtl <= 0
    ) {
      throw new Error(
        `IdempotencyInterceptor: processingTtl must be a positive integer number of seconds, received ${String(processingTtl)}`,
      );
    }
    const maxKeyLength = metadata.maxKeyLength !== undefined
      ? metadata.maxKeyLength
      : this.moduleOptions.maxKeyLength !== undefined
        ? this.moduleOptions.maxKeyLength
        : 255;
    if (!Number.isSafeInteger(maxKeyLength) || maxKeyLength <= 0) {
      throw new Error(
        'IdempotencyInterceptor: maxKeyLength must be a positive safe integer number of UTF-8 bytes',
      );
    }
    const scope = this.moduleOptions.scope === undefined
      ? 'endpoint'
      : this.moduleOptions.scope;
    if (scope !== 'endpoint' && scope !== 'global' && typeof scope !== 'function') {
      throw new Error('IdempotencyInterceptor: invalid scope configuration');
    }
    return {
      required: metadata.required ?? true,
      ttl,
      processingTtl,
      fingerprint:
        metadata.fingerprint ?? this.moduleOptions.fingerprint ?? true,
      headerName: this.moduleOptions.headerName ?? DEFAULT_HEADER_NAME,
      keyResolver:
        metadata.keyResolver ?? this.moduleOptions.keyResolver,
      maxKeyLength,
      scope,
      replayHeaders: this.moduleOptions.replayHeaders ?? true,
      observability: this.moduleOptions.observability,
    };
  }

  private async resolveRawKey(
    opts: ResolvedOptions,
    context: ExecutionContext,
    req: RequestShape,
  ): Promise<string | undefined> {
    let value: unknown;
    if (opts.keyResolver) {
      value = await opts.keyResolver(context);
    } else {
      const headerName = opts.headerName.toLowerCase();
      const rawHeaders = req.rawHeaders ?? req.raw?.rawHeaders ?? [];
      let occurrences = 0;
      for (let index = 0; index < rawHeaders.length; index += 2) {
        if (rawHeaders[index].toLowerCase() === headerName) occurrences += 1;
      }
      value = req.headers[headerName];
      if (
        occurrences > 1 ||
        Array.isArray(value) ||
        (typeof value === 'string' && value.includes(','))
      ) {
        throw new BadRequestException(
          `${opts.headerName} must contain exactly one key`,
        );
      }
    }
    if (value === undefined) return undefined;
    if (!isValidKeyString(value)) {
      throw new BadRequestException(
        `${opts.headerName} must be a nonblank string without control characters`,
      );
    }
    if (Buffer.byteLength(value, 'utf8') > opts.maxKeyLength) {
      throw new BadRequestException(
        `${opts.headerName} must be ${opts.maxKeyLength} UTF-8 bytes or fewer`,
      );
    }
    return value;
  }

  private async resolveFingerprint(
    opts: ResolvedOptions,
    context: ExecutionContext,
    rawKey: string,
    scopedKey: string,
    body: unknown,
  ): Promise<string | undefined> {
    if (opts.fingerprint === false) {
      return undefined;
    }

    const defaultFingerprint = (): string | undefined =>
      this.computeFingerprint(body);

    if (opts.fingerprint === true) {
      return defaultFingerprint();
    }

    return opts.fingerprint({
      context,
      key: rawKey,
      scope: scopedKey,
      body,
      defaultFingerprint,
    });
  }

  /**
   * Derives the namespaced storage key from the raw header value according
   * to the configured {@link IdempotencyScope}.
   *
   * For `scope: 'endpoint'` (the default), the interceptor first scopes by
   * the platform request's actual HTTP method + path. Express's
   * `req.originalUrl` wins, Fastify-style `req.url` is the fallback, query
   * strings are ignored, and the actual path's slashes are preserved.
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
  ): ScopedRequestKey {
    if (scope === 'global') {
      return createRequestKey(['global'], rawKey);
    }
    let identity: readonly string[] = [];
    if (typeof scope === 'function') {
      const resolved: unknown = scope(context);
      if (typeof resolved === 'string' && isValidKeyString(resolved)) {
        identity = [resolved];
      } else if (
        Array.isArray(resolved) &&
        resolved.length > 0 &&
        // Array.from visits sparse entries as undefined instead of skipping
        // them, so holes cannot silently become null in the encoded tuple.
        Array.from(resolved).every(isValidKeyString)
      ) {
        identity = Array.from(resolved);
      } else {
        // An accidentally async resolver is unsupported. Consume a rejected
        // native Promise so this configuration error cannot crash the process.
        if (resolved instanceof Promise) void resolved.catch(() => undefined);
        throw new Error(
          'IdempotencyInterceptor: scope must return a nonblank string or a nonempty array of nonblank strings',
        );
      }
    }
    return createRequestKey(
      ['endpoint', identity, this.computeEndpointScope(context)],
      rawKey,
    );
  }

  /**
   * Computes the endpoint scope prefix for a given execution context.
   * Split out of {@link applyScope} so the fallback chain is easy to read
   * and independently testable.
   */
  private computeEndpointScope(context: ExecutionContext): readonly string[] {
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
      return ['path', httpMethod, actualPath];
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
      return ['route', httpMethod, joined];
    }

    // Fallback: class name + method name. Not URL-accurate but isolates
    // handlers within a single controller at minimum.
    const className = controller?.name ?? 'UnknownController';
    const methodName = handler?.name ?? 'unknownHandler';
    return ['handler', httpMethod, className, methodName];
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

  /** Catch only the storage call, never downstream HTTP/handler errors. */
  private observeStorage<T>(
    opts: ResolvedOptions,
    scopedKey: ScopedRequestKey,
    operation: Exclude<IdempotencyStorageOperation, 'complete'>,
    call: () => Promise<T>,
  ): Observable<T> {
    return defer(call).pipe(
      catchError((err) => {
        this.emitEvent(opts, 'storage_error', scopedKey, {
          error: { code: 'storage_failure', operation },
        });
        return throwError(() => err);
      }),
    );
  }

  private eventContext(
    scopedKey: ScopedRequestKey,
  ): Pick<IdempotencyEvent, 'keyHash' | 'namespace'> {
    return {
      keyHash: createHash('sha256').update(scopedKey.key).digest('hex'),
      namespace: scopedKey.namespace,
    };
  }

  private emitEvent(
    opts: ResolvedOptions,
    outcome: IdempotencyOutcome,
    scopedKey: ScopedRequestKey,
    details: Pick<IdempotencyEvent, 'statusCode' | 'error'> = {},
  ): void {
    const onEvent = opts.observability?.onEvent;
    if (!onEvent) {
      return;
    }

    try {
      const maybePromise = onEvent({
        outcome,
        ...this.eventContext(scopedKey),
        ...details,
      });
      void Promise.resolve(maybePromise).catch(() => {
        logDiagnostic(this.logger, 'callback_failure', this.eventContext(scopedKey));
      });
    } catch {
      logDiagnostic(this.logger, 'callback_failure', this.eventContext(scopedKey));
    }
  }

  private setIdempotencyStatus(
    res: ResponseShape,
    opts: ResolvedOptions,
    status: string,
  ): void {
    if (!this.shouldExposeStatusHeaders(opts)) {
      return;
    }
    this.setHeader(res, 'Idempotency-Status', status);
  }

  private shouldExposeStatusHeaders(opts: ResolvedOptions): boolean {
    return opts.observability?.exposeStatusHeaders !== false;
  }

  private setHeader(res: ResponseShape, name: string, value: string): void {
    try {
      const setHeader = res.setHeader ?? res.header;
      if (setHeader) {
        void Promise.resolve(setHeader.call(res, name, value)).catch(() => undefined);
      }
    } catch {
      // Diagnostic headers are best effort, including after disconnect/send.
      // Their failure must not alter a business result or storage classification.
    }
  }
}
