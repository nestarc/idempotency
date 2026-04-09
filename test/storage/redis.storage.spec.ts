import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { RedisStorage } from '../../src/storage/redis.storage';

const buildClient = () => new RedisMock() as unknown as Redis;

describe('RedisStorage', () => {
  let client: Redis;
  let storage: RedisStorage;

  beforeEach(async () => {
    client = buildClient();
    // ioredis-mock instances share an in-memory dataset by default — flush
    // between tests so state from one test cannot leak into the next.
    await client.flushall();
    storage = new RedisStorage({ client });
  });

  afterEach(async () => {
    await client.flushall();
    await client.quit();
  });

  describe('get', () => {
    it('returns null for a missing key', async () => {
      await expect(storage.get('missing')).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('writes a PROCESSING JSON record under the prefixed key with the given TTL', async () => {
      const created = await storage.create('K1', 'fp', 10);
      expect(created).toBe(true);

      const raw = await client.get('idempotency:K1');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      expect(parsed.status).toBe('PROCESSING');
      expect(parsed.fingerprint).toBe('fp');
      expect(parsed.key).toBe('K1');

      const ttl = await client.ttl('idempotency:K1');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    it('returns false when the key already exists (NX semantics)', async () => {
      await storage.create('K1', 'fpA', 10);
      const second = await storage.create('K1', 'fpB', 10);
      expect(second).toBe(false);

      const record = await storage.get('K1');
      expect(record!.fingerprint).toBe('fpA');
    });

    it('races: only one of two concurrent creates wins', async () => {
      const results = await Promise.all([
        storage.create('K1', 'fp1', 10),
        storage.create('K1', 'fp2', 10),
      ]);
      // Exactly one true and one false.
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((v: boolean) => !v)).toHaveLength(1);
    });
  });

  describe('complete', () => {
    it('transitions to COMPLETED, refreshes TTL, and stores statusCode/body', async () => {
      await storage.create('K1', 'fp', 10);
      await storage.complete(
        'K1',
        { statusCode: 201, body: '{"id":"abc"}' },
        3600,
      );

      const record = await storage.get('K1');
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
      // Crucial: statusCode is parsed back to a NUMBER, not a string.
      expect(record!.statusCode).toBe(201);
      expect(typeof record!.statusCode).toBe('number');
      expect(record!.responseBody).toBe('{"id":"abc"}');

      const ttl = await client.ttl('idempotency:K1');
      expect(ttl).toBeGreaterThan(60);
      expect(ttl).toBeLessThanOrEqual(3600);
    });

    it('preserves the original createdAt across complete()', async () => {
      await storage.create('K1', 'fp', 10);
      const created = await storage.get('K1');
      const originalCreatedAt = created!.createdAt;

      // Sleep enough that a naive "set createdAt = now" would diverge measurably.
      await new Promise((r) => setTimeout(r, 5));

      await storage.complete('K1', { statusCode: 200, body: '{}' }, 3600);
      const completed = await storage.get('K1');

      // The core invariant: createdAt is identical to the original.
      expect(completed!.createdAt.getTime()).toBe(originalCreatedAt.getTime());
    });

    it('throws when called for a missing key', async () => {
      await expect(
        storage.complete('missing', { statusCode: 200, body: '{}' }, 60),
      ).rejects.toThrow(/not found|missing|exist/i);
    });

    it('passes through nested JSON bodies without double-encoding', async () => {
      await storage.create('K1', 'fp', 10);
      const nested = '{"nested":{"a":1,"b":[2,3]}}';
      await storage.complete('K1', { statusCode: 200, body: nested }, 60);
      const record = await storage.get('K1');
      expect(record!.responseBody).toBe(nested);
    });
  });

  describe('delete', () => {
    it('removes a record so subsequent get returns null', async () => {
      await storage.create('K1', undefined, 10);
      await storage.delete('K1');
      await expect(storage.get('K1')).resolves.toBeNull();
    });

    it('is a no-op for a missing key', async () => {
      await expect(storage.delete('missing')).resolves.toBeUndefined();
    });
  });

  describe('keyPrefix', () => {
    it('honors a custom prefix', async () => {
      const customStorage = new RedisStorage({
        client,
        keyPrefix: 'myapp:idem:',
      });
      await customStorage.create('K1', 'fp', 10);
      const raw = await client.get('myapp:idem:K1');
      expect(raw).not.toBeNull();
    });
  });

  describe('constructor accepts both client and connection options', () => {
    it('builds an internal Redis client from a connection options object', async () => {
      // We don't actually connect — RedisMock supports being constructed with
      // an options object, and our storage should accept that path.
      const storage2 = new RedisStorage({
        connection: { host: 'localhost', port: 6379 },
        // ioredis-mock's type signature doesn't accept connection options,
        // but the runtime constructor does. The cast is test-only.
        clientFactory: () => new (RedisMock as any)() as Redis,
      });
      const created = await storage2.create('Kx', 'fp', 10);
      expect(created).toBe(true);
      await storage2.close();
    });
  });
});
