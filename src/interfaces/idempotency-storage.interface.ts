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
 * Return shape of {@link IdempotencyStorage.create}.
 *
 * `acquired === true` means this caller successfully created a new PROCESSING
 * record and was given an opaque `token` that uniquely identifies that record.
 * The caller MUST pass this token back to `complete()` / `delete()` so the
 * storage can verify it still owns the record before mutating it.
 *
 * `acquired === false` means a record already existed (NX semantics). No token
 * is issued in this case.
 */
export interface CreateResult {
  acquired: boolean;
  token?: string;
}

/**
 * Return shape of {@link IdempotencyStorage.complete} and
 * {@link IdempotencyStorage.delete}.
 *
 * - `'ok'`: the operation succeeded — the caller's token matched the stored
 *   record (or, for delete, the record was already absent).
 * - `'stale'`: the caller's token does NOT match the record currently stored
 *   under this key. This happens when the original PROCESSING record was
 *   evicted by TTL and a newer caller has since created a fresh record. The
 *   original caller MUST NOT touch the newer record; storage silently refused
 *   the write.
 */
export type MutateResult = 'ok' | 'stale';

/**
 * Pluggable storage contract for idempotency records.
 *
 * Implementations must guarantee:
 * 1. Atomic creation (`NX` semantics) — two concurrent `create()` calls for
 *    the same key must result in exactly one `acquired: true` and one
 *    `acquired: false`.
 * 2. Token-based compare-and-set on `complete()` / `delete()` — a caller can
 *    only mutate a record whose stored token matches the token they received
 *    from their own `create()` call. This prevents the TTL-eviction race
 *    where a slow caller would otherwise clobber a newer caller's record.
 * 3. `createdAt` immutability — `complete()` and any other mutation MUST
 *    preserve the `createdAt` field of the original PROCESSING record.
 *    See {@link IdempotencyRecord.createdAt}.
 *
 * ### Lifecycle
 *
 * Storage adapters that hold external resources (Redis clients, DB
 * connections, timers) SHOULD implement Nest's `OnModuleDestroy` hook so
 * the resources are released when the host application shuts down. Both
 * built-in adapters (`MemoryStorage`, `RedisStorage`) do this — a custom
 * adapter is free to opt in the same way.
 *
 * A cross-adapter contract suite that exercises every requirement of this
 * interface lives at `test/support/shared-storage-contract.ts` — new
 * adapters should be plugged into it to guarantee LSP-level uniformity.
 */
export interface IdempotencyStorage {
  /**
   * Fetches a record by key. Returns null if the key does not exist or has expired.
   */
  get(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Atomically creates a PROCESSING record. On success, returns an opaque
   * token that the caller MUST pass back to `complete()` / `delete()`.
   *
   * @param key the idempotency key from the client header (already scoped
   *            by the interceptor to include endpoint identity)
   * @param fingerprint SHA-256 of the request body, or undefined if fingerprinting is off
   * @param ttlSeconds lifetime of the lock; the interceptor passes the resolved TTL
   */
  create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<CreateResult>;

  /**
   * Transitions a `PROCESSING` record to `COMPLETED` and stores the captured response,
   * but ONLY if the stored record's token matches the caller's token.
   * Returns `'stale'` if the token does not match — meaning the original record
   * was evicted and a newer one exists under this key. The caller's response
   * must not overwrite the newer record.
   *
   * On `'ok'`, implementations must refresh the TTL to `ttlSeconds`.
   */
  complete(
    key: string,
    token: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<MutateResult>;

  /**
   * Removes a record, but ONLY if the caller's token matches. Returns `'ok'`
   * if the record was removed OR was already absent (idempotent cleanup), and
   * `'stale'` only if a DIFFERENT record (with a different token) is currently
   * stored under this key.
   */
  delete(key: string, token: string): Promise<MutateResult>;
}
