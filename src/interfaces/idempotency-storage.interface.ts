import type { IdempotencyRecord } from './idempotency-record.interface';

/**
 * The response payload captured by the interceptor and persisted by storage.
 */
export interface CompleteResponse {
  /** HTTP status code emitted by the original handler. */
  statusCode: number;

  /** JSON-serialized response body, or undefined for empty bodies (e.g. 204). */
  body?: string;
}

/**
 * Pluggable storage contract for idempotency records.
 *
 * Implementations must guarantee atomic creation (`NX` semantics) so that
 * concurrent first-time requests with the same key cannot both proceed.
 */
export interface IdempotencyStorage {
  /**
   * Fetches a record by key. Returns null if the key does not exist or has expired.
   */
  get(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Atomically creates a `PROCESSING` record. Returns true on creation, false
   * if a record with this key already exists (NX semantics — acts as a lock).
   *
   * @param key the idempotency key from the client header
   * @param fingerprint SHA-256 of the request body, or undefined if fingerprinting is off
   * @param ttlSeconds lifetime of the lock; the interceptor passes the resolved TTL
   *                   (module default merged with per-handler override)
   */
  create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<boolean>;

  /**
   * Transitions a `PROCESSING` record to `COMPLETED` and stores the captured response.
   * Implementations must refresh the TTL to `ttlSeconds` so the cached response
   * is available for the full configured window.
   *
   * Throws if the key does not exist (invariant violation — `create` must have been
   * called first).
   */
  complete(
    key: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<void>;

  /**
   * Removes a key. Used by the interceptor when the handler throws, to allow
   * the client to retry with the same key. Idempotent — calling on a missing
   * key is a no-op.
   */
  delete(key: string): Promise<void>;
}
