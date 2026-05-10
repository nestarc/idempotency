/**
 * Shared storage contract test suite.
 *
 * Every built-in and custom `IdempotencyStorage` implementation is expected
 * to pass this suite. It encodes the *behavioral* guarantees of the
 * interface — things the TypeScript type checker cannot enforce:
 *
 *   1. `get()` on a missing key returns `null`.
 *   2. `create()` returns a token and yields a PROCESSING record.
 *   3. A second `create()` for the same key returns `acquired: false`
 *      and does not clobber the original record (NX semantics).
 *   4. `complete()` with a matching token transitions PROCESSING → COMPLETED
 *      and persists statusCode + body + headers.
 *   5. `complete()` with a wrong token returns `'stale'` and does NOT mutate.
 *   6. `complete()` preserves `createdAt` (invariant field).
 *   7. `delete()` with a matching token removes the record.
 *   8. `delete()` with a wrong token returns `'stale'` and does NOT remove.
 *   9. `delete()` on a missing key returns `'ok'` (idempotent cleanup).
 *  10. `complete()` refreshes `expiresAt` to the new TTL window.
 *
 * Plug a new adapter into the suite via `describeStorageContract('Name', factory)`
 * inside that adapter's spec file. Any behavioral drift between adapters will
 * be caught immediately.
 */
import type { IdempotencyStorage } from '../../src/interfaces/idempotency-storage.interface';

export interface StorageHarness {
  storage: IdempotencyStorage;
  /** Tear down any resources owned by the harness (timers, clients). */
  cleanup: () => Promise<void>;
}

export type StorageFactory = () => Promise<StorageHarness>;

export const describeStorageContract = (
  name: string,
  factory: StorageFactory,
): void => {
  describe(`${name} (shared contract)`, () => {
    let storage: IdempotencyStorage;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const harness = await factory();
      storage = harness.storage;
      cleanup = harness.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it('get() on a missing key returns null', async () => {
      await expect(storage.get('missing')).resolves.toBeNull();
    });

    it('create() returns a token and yields a PROCESSING record', async () => {
      const result = await storage.create('contract-1', 'fp', 60);
      expect(result.acquired).toBe(true);
      expect(typeof result.token).toBe('string');

      const record = await storage.get('contract-1');
      expect(record).not.toBeNull();
      expect(record!.token).toBe(result.token);
      expect(record!.status).toBe('PROCESSING');
      expect(record!.fingerprint).toBe('fp');
    });

    it('a second create() on the same key returns acquired=false without clobbering', async () => {
      const first = await storage.create('contract-2', 'fpA', 60);
      const second = await storage.create('contract-2', 'fpB', 60);
      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      expect(second.token).toBeUndefined();

      const record = await storage.get('contract-2');
      expect(record!.fingerprint).toBe('fpA');
      expect(record!.token).toBe(first.token);
    });

    it('complete() with a matching token transitions to COMPLETED', async () => {
      const { token } = await storage.create('contract-3', 'fp', 60);
      const result = await storage.complete(
        'contract-3',
        token!,
        { statusCode: 201, body: '{"id":"xyz"}' },
        3600,
      );
      expect(result).toBe('ok');

      const record = await storage.get('contract-3');
      expect(record!.status).toBe('COMPLETED');
      expect(record!.statusCode).toBe(201);
      expect(record!.responseBody).toBe('{"id":"xyz"}');
    });

    it('complete() snapshots response headers for replay', async () => {
      const headers: Record<string, string> = {
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
      };
      const { token } = await storage.create('contract-headers', 'fp', 60);
      const result = await storage.complete(
        'contract-headers',
        token!,
        { statusCode: 201, body: '{"id":"xyz"}', headers },
        3600,
      );
      expect(result).toBe('ok');

      headers.location = '/mutated';
      headers['x-added-after-complete'] = 'too-late';

      const record = await storage.get('contract-headers');
      expect(record!.responseHeaders).toEqual({
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
      });
    });

    it('complete() with a wrong token returns "stale" and does not mutate', async () => {
      await storage.create('contract-4', 'fp', 60);
      const result = await storage.complete(
        'contract-4',
        'wrong-token',
        { statusCode: 200, body: '{}' },
        60,
      );
      expect(result).toBe('stale');

      const record = await storage.get('contract-4');
      expect(record!.status).toBe('PROCESSING');
      expect(record!.responseBody).toBeUndefined();
    });

    // This is the LSP-level invariant that caught adapter drift.
    it('complete() preserves createdAt (invariant field)', async () => {
      const { token } = await storage.create('contract-5', 'fp', 60);
      const original = await storage.get('contract-5');
      const originalCreatedAt = original!.createdAt.getTime();

      // Ensure the clock has ticked so a naive "createdAt = now" would diverge.
      await new Promise((r) => setTimeout(r, 5));

      await storage.complete(
        'contract-5',
        token!,
        { statusCode: 200, body: '{}' },
        3600,
      );
      const completed = await storage.get('contract-5');
      expect(completed!.createdAt.getTime()).toBe(originalCreatedAt);
    });

    it('complete() refreshes expiresAt to the new TTL window', async () => {
      const { token } = await storage.create('contract-6', 'fp', 10);
      const beforeComplete = Date.now();
      await storage.complete(
        'contract-6',
        token!,
        { statusCode: 200, body: '{}' },
        3600,
      );
      const completed = await storage.get('contract-6');
      const expiresAtMs = completed!.expiresAt.getTime();
      // expiresAt should be approximately now + 3600s, not original + 10s.
      expect(expiresAtMs).toBeGreaterThanOrEqual(beforeComplete + 3599 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(beforeComplete + 3601 * 1000);
    });

    it('delete() with a matching token removes the record', async () => {
      const { token } = await storage.create('contract-7', 'fp', 60);
      const result = await storage.delete('contract-7', token!);
      expect(result).toBe('ok');
      await expect(storage.get('contract-7')).resolves.toBeNull();
    });

    it('delete() with a wrong token returns "stale" and leaves the record intact', async () => {
      await storage.create('contract-8', 'fp', 60);
      const result = await storage.delete('contract-8', 'wrong-token');
      expect(result).toBe('stale');
      await expect(storage.get('contract-8')).resolves.not.toBeNull();
    });

    it('delete() on a missing key returns "ok" (idempotent cleanup)', async () => {
      const result = await storage.delete('contract-missing', 'any-token');
      expect(result).toBe('ok');
    });
  });
};
