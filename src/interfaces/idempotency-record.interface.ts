/**
 * Lifecycle state of an idempotency record.
 *
 * - `PROCESSING`: a request with this key is currently being handled.
 *   A duplicate request arriving in this state should receive HTTP 409 Conflict.
 * - `COMPLETED`: the request finished and its response is cached. A duplicate
 *   request with the same fingerprint should be replayed from the stored response.
 */
export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED';

/**
 * The persisted shape of an idempotency record across all storage adapters.
 *
 * v0.1 caches only `statusCode` and `responseBody`. Response headers are deferred
 * to v0.2.
 */
export interface IdempotencyRecord {
  /** The exact value of the `Idempotency-Key` header from the original request. */
  key: string;

  /**
   * Opaque token issued by `IdempotencyStorage.create()` that uniquely
   * identifies THIS record across its lifetime. Used by `complete()` /
   * `delete()` to compare-and-set so that a slow caller cannot clobber a
   * newer caller's record after TTL eviction.
   */
  token: string;

  /**
   * SHA-256 of the request body, used to detect a key being reused with a
   * different payload (which produces HTTP 422 per the IETF draft).
   * Undefined when fingerprinting is disabled.
   */
  fingerprint?: string;

  /** Current lifecycle state. */
  status: IdempotencyStatus;

  /** Captured HTTP status code of the original handler response. */
  statusCode?: number;

  /** JSON-serialized response body, ready to be parsed and replayed. */
  responseBody?: string;

  /** When the record was first created. */
  createdAt: Date;

  /** When the record will be evicted by the storage adapter. */
  expiresAt: Date;
}
