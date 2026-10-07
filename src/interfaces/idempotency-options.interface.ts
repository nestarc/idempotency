import type { ExecutionContext, ModuleMetadata, Type } from '@nestjs/common';
import type { IdempotencyStorage } from './idempotency-storage.interface';

/**
 * How the interceptor derives the storage-key namespace from the request.
 *
 * - `'endpoint'` (default) — scope by actual HTTP method + request path when
 *   available, falling back to Nest route metadata and then controller class +
 *   handler method name. Actual path parameters, duplicate/trailing slashes
 *   and percent encoding are preserved; query strings are excluded.
 *   No authenticated identity is inferred. Two different endpoints using the SAME
 *   `Idempotency-Key` value will NOT collide. Matches the IETF draft
 *   recommendation that the key be unique per (key, request URI) tuple.
 *
 * - `'global'` — share keys across all identities and endpoints in the storage.
 *   Only use when all callers are authorized to share every replayed response.
 *   Storage keys are still versioned and encoded.
 *
 * - A synchronous function — ADD authenticated identity to the endpoint.
 *   Return a nonblank string or a nonempty array of nonblank strings, e.g.
 *   `[req.user.tenantId, req.user.id]`. Array boundaries are preserved.
 *   Guards must authenticate/authorize before this interceptor on every retry.
 *   Unlike 0.4, functions never replace the endpoint. All modes use the v1
 *   key encoding with no legacy alias lookup. Upgrades require a separate empty
 *   storage namespace and business deduplication; see the migration contract.
 */
export type IdempotencyScope =
  | 'endpoint'
  | 'global'
  | ((context: ExecutionContext) => string | readonly string[]);

export type ReplayHeadersOption = boolean | string[];

/**
 * Resolves the idempotency key for a request. Use this when the stable key
 * comes from a webhook event id, command id, or other application-level value
 * instead of the configured HTTP header.
 */
export type IdempotencyKeyResolver = (
  context: ExecutionContext,
) => string | undefined | Promise<string | undefined>;

export interface IdempotencyFingerprintInput {
  context: ExecutionContext;
  key: string;
  scope: string;
  body: unknown;
  defaultFingerprint: () => string | undefined;
}

/**
 * Resolves the fingerprint used to detect reuse of the same idempotency key
 * with a semantically different request.
 */
export type IdempotencyFingerprintResolver = (
  input: IdempotencyFingerprintInput,
) => string | undefined | Promise<string | undefined>;

export type IdempotencyOutcome =
  | 'created'
  | 'replayed'
  | 'conflict'
  | 'mismatch'
  | 'bypassed'
  | 'stale'
  | 'complete_error'
  | 'storage_error';

/** The failed storage call; race_get is the re-read after losing create(). */
export type IdempotencyStorageOperation =
  | 'get'
  | 'create'
  | 'race_get'
  | 'complete'
  | 'delete';

/** Package-owned diagnostics. Original thrown values are never included. */
export type IdempotencyEventError =
  | { code: 'storage_failure'; operation: IdempotencyStorageOperation }
  | { code: 'response_not_replayable' };

export interface IdempotencyEvent {
  outcome: IdempotencyOutcome;
  /** SHA-256 of the v1 encoded storage key; not a metric label or encryption. */
  keyHash: string;
  /** S3 v1 identity + endpoint namespace hash, independent of the raw key. */
  namespace: string;
  statusCode?: number;
  error?: IdempotencyEventError;
}

export interface IdempotencyObservabilityOptions {
  /** Best effort, not awaited. Throws/rejections never change request handling. */
  onEvent?: (event: IdempotencyEvent) => void | Promise<void>;
  /** Defaults to true. These headers are generated afresh, never replayed. */
  exposeStatusHeaders?: boolean;
}

/**
 * Module-level configuration passed to {@link IdempotencyModule.forRoot}.
 */
export interface IdempotencyOptions {
  /**
   * The storage adapter instance to use. Construct it yourself
   * (e.g. `new MemoryStorage()` or `new RedisStorage({ host, port })`)
   * for full type-safe control over adapter wiring.
   */
  storage: IdempotencyStorage;

  /**
   * Default time-to-live for idempotency records, in seconds.
   * Per-handler `@Idempotent({ ttl })` overrides this.
   * Completed replay records use this TTL. In-flight PROCESSING records also
   * use this TTL unless {@link processingTtl} is configured.
   * Must be an integer from 1 through 2_147_483_647; otherwise a RangeError
   * is emitted at request time before storage or handler execution.
   *
   * @default 86400 (24 hours)
   */
  ttl?: number;

  /**
   * Optional time-to-live for in-flight PROCESSING records, in seconds.
   * When omitted, {@link ttl} is used for both processing locks and completed
   * replay records. Per-handler `@Idempotent({ processingTtl })` overrides this.
   * Must be an integer from 1 through 2_147_483_647, like {@link ttl}.
   *
   * Configure this only when you want stuck in-flight records to expire sooner
   * than completed replay records. Values shorter than the endpoint's real
   * processing time can allow duplicate execution.
   */
  processingTtl?: number;

  /**
   * The HTTP header name carrying one raw opaque key string. Repeated fields,
   * arrays and comma-joined values are rejected. Quotes are literal; this is
   * not a Structured Field String parser.
   *
   * @default 'Idempotency-Key'
   */
  headerName?: string;

  /**
   * Optional application-level idempotency key resolver. When configured, its
   * return value is used instead of reading the configured header. Only
   * undefined means missing. Invalid strings/non-string results produce 400
   * even when required:false. Commas are allowed in resolver keys.
   */
  keyResolver?: IdempotencyKeyResolver;

  /**
   * Maximum accepted idempotency key length, in UTF-8 bytes. Must be a positive
   * safe integer. Empty/blank strings, controls and unpaired surrogates are
   * rejected. Strings are not trimmed or Unicode-normalized by this package.
   *
   * @default 255
   */
  maxKeyLength?: number;

  /**
   * When true, the interceptor computes a SHA-256 fingerprint of the request body
   * and verifies it on subsequent requests. Pass a resolver function to provide
   * an application-specific semantic fingerprint. A mismatch produces HTTP 422.
   *
   * @default true
   */
  fingerprint?: boolean | IdempotencyFingerprintResolver;

  /**
   * How storage keys are namespaced. See {@link IdempotencyScope}.
   *
   * @default 'endpoint'
   */
  scope?: IdempotencyScope;

  /**
   * Controls which response headers are captured and replayed.
   *
   * `true` or undefined uses the conservative default allowlist.
   * `false` disables header replay.
   * A string array uses an explicit allowlist, still filtered through the
   * unsafe header denylist.
   *
   * @default true
   */
  replayHeaders?: ReplayHeadersOption;

  /**
   * Optional operational hooks and client-visible status headers.
   */
  observability?: IdempotencyObservabilityOptions;

  /**
   * When true, the module is registered as a global module (no need to import
   * it into every consumer module).
   *
   * @default true
   */
  isGlobal?: boolean;
}

/**
 * Factory contract for `useClass` / `useExisting` async registration paths.
 */
export interface IdempotencyOptionsFactory {
  createIdempotencyOptions():
    | Promise<IdempotencyOptions>
    | IdempotencyOptions;
}

/**
 * Async configuration passed to {@link IdempotencyModule.forRootAsync}.
 * Mirrors the standard NestJS async-module pattern (useFactory / useClass / useExisting).
 */
export interface IdempotencyAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useExisting?: Type<IdempotencyOptionsFactory>;
  useClass?: Type<IdempotencyOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<IdempotencyOptions> | IdempotencyOptions;
  inject?: any[];
  isGlobal?: boolean;
}

/**
 * Per-handler overrides accepted by the {@link Idempotent} decorator.
 */
export interface IdempotentOptions {
  /**
   * When true, the `Idempotency-Key` header is mandatory and a missing header
   * produces HTTP 400. When false, requests without the header pass through
   * normally (no idempotency check).
   *
   * @default true
   */
  required?: boolean;

  /**
   * Override the module-level TTL for this handler (in seconds).
   * Must be an integer from 1 through 2_147_483_647.
   */
  ttl?: number;

  /**
   * Override the module-level processing TTL for this handler (in seconds).
   * Must be an integer from 1 through 2_147_483_647.
   */
  processingTtl?: number;

  /**
   * Override the module-level key resolver for this handler.
   */
  keyResolver?: IdempotencyKeyResolver;

  /**
   * Override the module-level maximum key length for this handler.
   */
  maxKeyLength?: number;

  /**
   * Override the module-level fingerprint setting for this handler.
   */
  fingerprint?: boolean | IdempotencyFingerprintResolver;
}

/**
 * The metadata shape persisted via `SetMetadata` by the {@link Idempotent} decorator.
 * The `enabled: true` flag lets the interceptor distinguish "decorator applied
 * with no overrides" from "no decorator at all".
 */
export interface IdempotentMetadata extends IdempotentOptions {
  enabled: true;
}
