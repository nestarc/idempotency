import type {
  CompleteResponse,
  IdempotencyStorage,
} from '../../src/interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../../src/interfaces/idempotency-record.interface';

/**
 * Hand-rolled in-memory test double for `IdempotencyStorage`.
 *
 * Each method is wrapped in `jest.fn(...)` so tests can assert call shapes
 * (`storage.create.mock.calls[0]`) without losing the real semantics. The
 * `ledger` array records every method invocation in order, which is essential
 * for the interceptor's "complete-before-emit" race condition test.
 */
export class FakeStorage implements IdempotencyStorage {
  private readonly records = new Map<string, IdempotencyRecord>();

  /** Append-only event log used to assert ordering across async boundaries. */
  readonly ledger: Array<
    | { op: 'get'; key: string }
    | { op: 'create'; key: string; result: boolean }
    | { op: 'complete'; key: string; statusCode: number }
    | { op: 'delete'; key: string }
  > = [];

  get = jest.fn(async (key: string): Promise<IdempotencyRecord | null> => {
    this.ledger.push({ op: 'get', key });
    return this.records.get(key) ?? null;
  });

  create = jest.fn(
    async (
      key: string,
      fingerprint: string | undefined,
      ttlSeconds: number,
    ): Promise<boolean> => {
      if (this.records.has(key)) {
        this.ledger.push({ op: 'create', key, result: false });
        return false;
      }
      const now = new Date();
      this.records.set(key, {
        key,
        fingerprint,
        status: 'PROCESSING',
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
      this.ledger.push({ op: 'create', key, result: true });
      return true;
    },
  );

  complete = jest.fn(
    async (
      key: string,
      response: CompleteResponse,
      ttlSeconds: number,
    ): Promise<void> => {
      const existing = this.records.get(key);
      if (!existing) {
        throw new Error(`FakeStorage.complete: missing key ${key}`);
      }
      const now = new Date();
      this.records.set(key, {
        ...existing,
        status: 'COMPLETED',
        statusCode: response.statusCode,
        responseBody: response.body,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
      this.ledger.push({ op: 'complete', key, statusCode: response.statusCode });
    },
  );

  delete = jest.fn(async (key: string): Promise<void> => {
    this.records.delete(key);
    this.ledger.push({ op: 'delete', key });
  });

  /**
   * Test helper: pre-seed a record without going through the public API.
   * Useful for setting up "already PROCESSING" or "already COMPLETED" states.
   */
  seed(record: IdempotencyRecord): void {
    this.records.set(record.key, record);
  }
}
