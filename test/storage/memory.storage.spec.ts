import { MemoryStorage } from '../../src/storage/memory.storage';

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
    it('creates a PROCESSING record and returns true', async () => {
      const created = await storage.create('k1', 'fp', 10);
      expect(created).toBe(true);

      const record = await storage.get('k1');
      expect(record).not.toBeNull();
      expect(record!.key).toBe('k1');
      expect(record!.fingerprint).toBe('fp');
      expect(record!.status).toBe('PROCESSING');
      expect(record!.statusCode).toBeUndefined();
      expect(record!.responseBody).toBeUndefined();

      const lifetimeMs =
        record!.expiresAt.getTime() - record!.createdAt.getTime();
      expect(lifetimeMs).toBe(10_000);
    });

    it('returns false on the second call for the same key (NX semantics)', async () => {
      const first = await storage.create('k1', 'fpA', 10);
      const second = await storage.create('k1', 'fpB', 10);

      expect(first).toBe(true);
      expect(second).toBe(false);

      // Original record must NOT be clobbered.
      const record = await storage.get('k1');
      expect(record!.fingerprint).toBe('fpA');
    });
  });

  describe('complete', () => {
    it('transitions PROCESSING to COMPLETED and stores the response', async () => {
      await storage.create('k1', 'fp', 10);
      await storage.complete(
        'k1',
        { statusCode: 201, body: '{"id":"abc"}' },
        60,
      );

      const record = await storage.get('k1');
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
      expect(record!.statusCode).toBe(201);
      expect(record!.responseBody).toBe('{"id":"abc"}');

      // TTL should be refreshed to the new value (60 seconds).
      const lifetimeMs =
        record!.expiresAt.getTime() - record!.createdAt.getTime();
      expect(lifetimeMs).toBe(60_000);
    });

    it('throws when called for a key that does not exist', async () => {
      await expect(
        storage.complete('missing', { statusCode: 200 }, 10),
      ).rejects.toThrow(/not found|missing|exist/i);
    });
  });

  describe('delete', () => {
    it('removes a record so subsequent get returns null', async () => {
      await storage.create('k1', undefined, 10);
      await storage.delete('k1');
      await expect(storage.get('k1')).resolves.toBeNull();
    });

    it('is a no-op for a missing key', async () => {
      await expect(storage.delete('missing')).resolves.toBeUndefined();
    });
  });

  describe('TTL', () => {
    it('evicts a record after its TTL elapses', async () => {
      await storage.create('k1', 'fp', 5);
      jest.advanceTimersByTime(5_000);
      await expect(storage.get('k1')).resolves.toBeNull();
    });

    it('refreshes the TTL on complete()', async () => {
      await storage.create('k1', 'fp', 5);
      jest.advanceTimersByTime(3_000);

      // Halfway through the original TTL: complete with a much longer TTL.
      await storage.complete('k1', { statusCode: 200, body: '{}' }, 60);

      // Advance well past the original 5s window — the record must still be there.
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
