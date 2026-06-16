import type { ExecutionContext, ModuleMetadata, Type } from '@nestjs/common';
import type { IdempotencyStorage } from './idempotency-storage.interface';

/**
 * How the interceptor derives the storage-key namespace from the request.
 *
 * - `'endpoint'` (default) — scope by actual HTTP method + request path when
 *   available, falling back to Nest route metadata and then controller class +
 *   handler method name. Two different endpoints using the SAME
 *   `Idempotency-Key` value will NOT collide. Matches the IETF draft
 *   recommendation that the key be unique per (key, request URI) tuple.
 *
 * - `'global'` — legacy behavior: use the raw header value as the storage
 *   key with no namespace. Safe only if clients guarantee globally-unique
 *   keys across all endpoints (e.g. fresh UUIDs per request).
 *
 * - A function `(ctx) => string` — fully custom scoping. Useful in
 *   multi-tenant systems where the scope should include the tenant ID.
 *   The returned string will be combined with the raw header value.
 */
export type IdempotencyScope =
  | 'endpoint'
  | 'global'
  | ((context: ExecutionContext) => string);

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

export interface IdempotencyEvent {
  outcome: IdempotencyOutcome;
  keyHash: string;
  scope: string;
  statusCode?: number;
  error?: unknown;
}

export interface IdempotencyObservabilityOptions {
  onEvent?: (event: IdempotencyEvent) => void | Promise<void>;
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
   *
   * @default 86400 (24 hours)
   */
  ttl?: number;

  /**
   * Optional time-to-live for in-flight PROCESSING records, in seconds.
   * When omitted, {@link ttl} is used for both processing locks and completed
   * replay records. Per-handler `@Idempotent({ processingTtl })` overrides this.
   *
   * Configure this only when you want stuck in-flight records to expire sooner
   * than completed replay records. Values shorter than the endpoint's real
   * processing time can allow duplicate execution.
   */
  processingTtl?: number;

  /**
   * The HTTP header name carrying the idempotency key. Override only if you
   * need to deviate from the IETF draft default.
   *
   * @default 'Idempotency-Key'
   */
  headerName?: string;

  /**
   * Optional application-level idempotency key resolver. When configured, its
   * return value is used instead of reading the configured header.
   */
  keyResolver?: IdempotencyKeyResolver;

  /**
   * Maximum accepted idempotency key length, in characters.
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
   */
  ttl?: number;

  /**
   * Override the module-level processing TTL for this handler (in seconds).
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
