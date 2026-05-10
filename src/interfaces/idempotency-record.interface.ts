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

  /** Lowercase HTTP response headers captured for replay. */
  responseHeaders?: Record<string, string>;

  /**
   * When the record was first created by `IdempotencyStorage.create()`.
   *
   * **Invariant**: this field is IMMUTABLE over the lifetime of a record.
   * `complete()` and any other mutation MUST preserve the original value.
   * Storage adapters that rewrite `createdAt` on update are non-conformant
   * and WILL break consumers who use it for monitoring (e.g. first-seen
   * timestamps in metrics / audit trails).
   */
  createdAt: Date;

  /**
   * When the record will be evicted by the storage adapter.
   * Unlike `createdAt`, this field IS mutated on `complete()` when the
   * adapter refreshes the TTL window to the new (typically longer) value.
   */
  expiresAt: Date;
}
