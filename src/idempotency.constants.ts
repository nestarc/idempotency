/**
 * Injection token for the resolved {@link IdempotencyOptions} instance.
 */
export const IDEMPOTENCY_OPTIONS = Symbol('IDEMPOTENCY_OPTIONS');

/**
 * Injection token for the {@link IdempotencyStorage} instance the interceptor uses.
 */
export const IDEMPOTENCY_STORAGE = Symbol('IDEMPOTENCY_STORAGE');

/**
 * Reflector metadata key carrying the per-handler {@link IdempotentMetadata}.
 *
 * Stored as a plain string (not Symbol) for maximum compatibility with
 * Nest's `Reflector.get` and `Reflect.getMetadata`.
 */
export const IDEMPOTENT_METADATA_KEY = 'nestarc:idempotent';

/**
 * Default HTTP header name carrying the idempotency key.
 * Matches the IETF draft `httpapi-idempotency-key-header-07`.
 */
export const DEFAULT_HEADER_NAME = 'Idempotency-Key';

/**
 * Default time-to-live for idempotency records, in seconds (24 hours).
 */
export const DEFAULT_TTL_SECONDS = 86_400;
