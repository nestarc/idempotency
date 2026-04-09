import { randomUUID } from 'crypto';
import type {
  CompleteResponse,
  CreateResult,
  IdempotencyStorage,
  MutateResult,
} from '../../src/interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../../src/interfaces/idempotency-record.interface';

/**
 * Hand-rolled in-memory test double for `IdempotencyStorage`.
 *
 * Implements the same token-CAS semantics as `MemoryStorage` so the
 * interceptor tests exercise the real contract. Each method is wrapped in
 * `jest.fn(...)` so tests can assert call shapes. The `ledger` array records
 * every method invocation in order, which is essential for the interceptor's
 * "complete-before-emit" race condition test.
 */
export class FakeStorage implements IdempotencyStorage {
  private readonly records = new Map<string, IdempotencyRecord>();

  /** Append-only event log used to assert ordering across async boundaries. */
  readonly ledger: Array<
    | { op: 'get'; key: string }
    | { op: 'create'; key: string; acquired: boolean }
    | { op: 'complete'; key: string; statusCode: number; result: MutateResult }
    | { op: 'delete'; key: string; result: MutateResult }
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
    ): Promise<CreateResult> => {
      if (this.records.has(key)) {
        this.ledger.push({ op: 'create', key, acquired: false });
        return { acquired: false };
      }
      const now = new Date();
      const token = randomUUID();
      this.records.set(key, {
        key,
        token,
        fingerprint,
        status: 'PROCESSING',
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
      this.ledger.push({ op: 'create', key, acquired: true });
      return { acquired: true, token };
    },
  );

  complete = jest.fn(
    async (
      key: string,
      token: string,
      response: CompleteResponse,
      ttlSeconds: number,
    ): Promise<MutateResult> => {
      const existing = this.records.get(key);
      if (!existing || existing.token !== token) {
        this.ledger.push({
          op: 'complete',
          key,
          statusCode: response.statusCode,
          result: 'stale',
        });
        return 'stale';
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
      this.ledger.push({
        op: 'complete',
        key,
        statusCode: response.statusCode,
        result: 'ok',
      });
      return 'ok';
    },
  );

  delete = jest.fn(async (key: string, token: string): Promise<MutateResult> => {
    const existing = this.records.get(key);
    if (!existing) {
      this.ledger.push({ op: 'delete', key, result: 'ok' });
      return 'ok';
    }
    if (existing.token !== token) {
      this.ledger.push({ op: 'delete', key, result: 'stale' });
      return 'stale';
    }
    this.records.delete(key);
    this.ledger.push({ op: 'delete', key, result: 'ok' });
    return 'ok';
  });

  /**
   * Test helper: pre-seed a record without going through the public API.
   * If `token` is omitted, a fresh UUID is assigned so tests that don't care
   * about the token value still get a valid record.
   */
  seed(record: Omit<IdempotencyRecord, 'token'> & { token?: string }): string {
    const token = record.token ?? randomUUID();
    this.records.set(record.key, { ...record, token });
    return token;
  }
}
