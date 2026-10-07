import type { IdempotencyRecord } from './idempotency-record.interface';

/**
 * The response payload captured by the interceptor and persisted by storage.
 */
export interface CompleteResponse {
  /** HTTP status code emitted by the original handler. */
  statusCode: number;

  /**
   * Opaque replay payload. Store and return this string unchanged; do not
   * JSON.parse/stringify or otherwise normalize it. The interceptor writes a
   * versioned envelope, including for empty HTTP bodies. Optional for storage
   * callers and older records; missing/legacy payloads are not replayed.
   */
  body?: string;

  /** Lowercase HTTP response headers captured for replay. */
  headers?: Record<string, string>;
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
 * - `'ok'`: a live PROCESSING record completed, or delete removed the owned
 *   record / found it logically absent (including expiry).
 * - `'stale'`: complete found a missing, expired, already COMPLETED, or
 *   differently owned record; or delete found a live record with another
 *   token. No response, TTL, token or createdAt is changed on this path.
 *   Expiry alone is sufficient: a replacement does not need to exist.
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
 * 4. Logical expiry — a lease is absent at its storage deadline even when
 *    physical timer/sweep cleanup has not run. All operations share the same
 *    deadline; an expired owner cannot revive the lease with complete().
 * 5. Complete once — only a live PROCESSING record may become COMPLETED.
 *    Repeated/concurrent complete with the same token returns stale after
 *    the first success, preserving its response and retention deadline.
 *
 * ### Lifecycle
 *
 * Storage adapters that hold external resources (Redis clients, DB
 * connections, timers) SHOULD implement Nest's `OnModuleDestroy` hook so
 * the resources are released when the host application shuts down. Both
 * built-in adapters (`MemoryStorage`, `RedisStorage`, `PostgresStorage`) do this — a custom
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
   * An expired record is absent for NX purposes, regardless of physical cleanup.
   *
   * @param key the idempotency key from the client header (already scoped
   *            by the interceptor to include endpoint identity)
   * @param fingerprint SHA-256 of the request body, or undefined if fingerprinting is off
   * @param ttlSeconds lifetime of the lock; the interceptor passes the resolved TTL
   */
  create(key: string, fingerprint: string | undefined, ttlSeconds: number): Promise<CreateResult>;

  /**
   * Transitions a `PROCESSING` record to `COMPLETED` and stores the captured response,
   * but ONLY if the record is unexpired and its token matches the caller's.
   * Returns `'stale'` for missing/expired records, token mismatches, and an
   * already COMPLETED record (including the same token). A stale operation
   * must not overwrite a response or refresh TTL.
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
   * if the record was removed OR was absent/expired (idempotent cleanup), and
   * `'stale'` only if a DIFFERENT record (with a different token) is currently
   * stored and unexpired under this key. Expired physical rows may remain for
   * later cleanup; delete success does not promise immediate physical removal.
   */
  delete(key: string, token: string): Promise<MutateResult>;
}
