import { MemoryStorage } from '../../src/storage/memory.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

// Plug MemoryStorage into the shared behavioral contract suite.
// Uses real timers so the contract's async createdAt test runs unaffected
// by the per-test fake-timer setup below.
describeStorageContract('MemoryStorage', async () => {
  const storage = new MemoryStorage();
  return {
    storage,
    cleanup: async () => {
      await storage.onModuleDestroy();
    },
  };
});

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    jest.useFakeTimers();
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('get', () => {
    it('returns null for a missing key', async () => {
      await expect(storage.get('missing')).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('creates a PROCESSING record and returns a token', async () => {
      const result = await storage.create('k1', 'fp', 10);
      expect(result.acquired).toBe(true);
      expect(typeof result.token).toBe('string');
      expect(result.token).toMatch(/^[0-9a-f-]{36}$/i);

      const record = await storage.get('k1');
      expect(record).not.toBeNull();
      expect(record!.key).toBe('k1');
      expect(record!.token).toBe(result.token);
      expect(record!.fingerprint).toBe('fp');
      expect(record!.status).toBe('PROCESSING');
      const lifetimeMs =
        record!.expiresAt.getTime() - record!.createdAt.getTime();
      expect(lifetimeMs).toBe(10_000);
    });

    it('returns acquired=false on the second call for the same key (NX semantics)', async () => {
      const first = await storage.create('k1', 'fpA', 10);
      const second = await storage.create('k1', 'fpB', 10);

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      expect(second.token).toBeUndefined();

      // Original record intact.
      const record = await storage.get('k1');
      expect(record!.fingerprint).toBe('fpA');
    });
  });

  describe('complete', () => {
    it('transitions PROCESSING to COMPLETED and refreshes the expiresAt window', async () => {
      const { token } = await storage.create('k1', 'fp', 10);
      const originalCreatedAt = (await storage.get('k1'))!.createdAt.getTime();
      // Advance the fake clock so a naive "createdAt = now" would be detectable.
      jest.advanceTimersByTime(1_000);
      const beforeComplete = Date.now();

      const result = await storage.complete(
        'k1',
        token!,
        { statusCode: 201, body: '{"id":"abc"}' },
        60,
      );
      expect(result).toBe('ok');

      const record = await storage.get('k1');
      expect(record!.status).toBe('COMPLETED');
      expect(record!.statusCode).toBe(201);
      expect(record!.responseBody).toBe('{"id":"abc"}');

      // createdAt is IMMUTABLE — it must still equal the original.
      expect(record!.createdAt.getTime()).toBe(originalCreatedAt);
      // expiresAt is REFRESHED to (now + ttlSeconds).
      expect(record!.expiresAt.getTime()).toBe(beforeComplete + 60_000);
    });

    it('returns "stale" when the key does not exist', async () => {
      const result = await storage.complete(
        'missing',
        'some-token',
        { statusCode: 200 },
        10,
      );
      expect(result).toBe('stale');
    });

    it('returns "stale" when the token does not match (post-TTL replacement race)', async () => {
      // Request A creates a record with a SHORT ttl.
      const a = await storage.create('k1', 'fpA', 1);
      // Time passes, record is evicted.
      jest.advanceTimersByTime(1_100);
      // Request B creates a fresh record for the same key.
      const b = await storage.create('k1', 'fpB', 60);
      const bCreatedAt = (await storage.get('k1'))!.createdAt.getTime();
      expect(b.acquired).toBe(true);
      expect(b.token).not.toBe(a.token);

      // Request A (which had the short ttl) now tries to complete.
      // Its token no longer matches the stored record — storage MUST refuse.
      const result = await storage.complete(
        'k1',
        a.token!,
        { statusCode: 200, body: '{"owner":"A"}' },
        60,
      );
      expect(result).toBe('stale');

      // Verify B's record was NOT clobbered, including createdAt.
      const record = await storage.get('k1');
      expect(record!.token).toBe(b.token);
      expect(record!.fingerprint).toBe('fpB');
      expect(record!.responseBody).toBeUndefined();
      expect(record!.status).toBe('PROCESSING');
      expect(record!.createdAt.getTime()).toBe(bCreatedAt);
    });
  });

  describe('delete', () => {
    it('removes a record when the token matches', async () => {
      const { token } = await storage.create('k1', undefined, 10);
      const result = await storage.delete('k1', token!);
      expect(result).toBe('ok');
      await expect(storage.get('k1')).resolves.toBeNull();
    });

    it('returns "ok" for a missing key (idempotent cleanup)', async () => {
      const result = await storage.delete('missing', 'any-token');
      expect(result).toBe('ok');
    });

    it('returns "stale" when the token does not match', async () => {
      await storage.create('k1', 'fp', 10);
      const result = await storage.delete('k1', 'wrong-token');
      expect(result).toBe('stale');
      // Record NOT deleted.
      await expect(storage.get('k1')).resolves.not.toBeNull();
    });
  });

  describe('TTL', () => {
    it('evicts a record after its TTL elapses', async () => {
      await storage.create('k1', 'fp', 5);
      jest.advanceTimersByTime(5_000);
      await expect(storage.get('k1')).resolves.toBeNull();
    });

    it('refreshes the TTL on complete()', async () => {
      const { token } = await storage.create('k1', 'fp', 5);
      jest.advanceTimersByTime(3_000);
      await storage.complete('k1', token!, { statusCode: 200, body: '{}' }, 60);
      jest.advanceTimersByTime(10_000);
      const record = await storage.get('k1');
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
    });
  });

  describe('OnModuleDestroy', () => {
    it('clears all pending timers to prevent leaks', async () => {
      await storage.create('a', undefined, 100);
      await storage.create('b', undefined, 100);
      await storage.create('c', undefined, 100);
      expect(jest.getTimerCount()).toBeGreaterThanOrEqual(3);
      await storage.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
