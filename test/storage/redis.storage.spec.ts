import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { RedisStorage } from '../../src/storage/redis.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const buildClient = () => new RedisMock() as unknown as Redis;

// Plug RedisStorage into the shared behavioral contract suite. Each test
// gets a fresh mock client and the storage is torn down via onModuleDestroy
// (which delegates to close()).
describeStorageContract('RedisStorage', async () => {
  const client = buildClient();
  await client.flushall();
  const storage = new RedisStorage({ client });
  return {
    storage,
    cleanup: async () => {
      await client.flushall();
      await client.quit();
    },
  };
});

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
    it('writes a PROCESSING Hash with token and payload, sets the TTL, and returns a token', async () => {
      const result = await storage.create('K1', 'fp', 10);
      expect(result.acquired).toBe(true);
      expect(result.token).toMatch(/^[0-9a-f-]{36}$/i);

      const hash = await (client as any).hgetall('idempotency:K1');
      expect(hash.token).toBe(result.token);
      const payload = JSON.parse(hash.payload);
      expect(payload.status).toBe('PROCESSING');
      expect(payload.fingerprint).toBe('fp');

      const ttl = await (client as any).ttl('idempotency:K1');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    it('returns acquired=false when the key already exists (NX semantics)', async () => {
      await storage.create('K1', 'fpA', 10);
      const second = await storage.create('K1', 'fpB', 10);
      expect(second.acquired).toBe(false);

      const record = await storage.get('K1');
      expect(record!.fingerprint).toBe('fpA');
    });

    it('races: only one of two concurrent creates wins', async () => {
      const results = await Promise.all([
        storage.create('K1', 'fp1', 10),
        storage.create('K1', 'fp2', 10),
      ]);
      const acquired = results.filter((r) => r.acquired);
      const refused = results.filter((r) => !r.acquired);
      expect(acquired).toHaveLength(1);
      expect(refused).toHaveLength(1);
    });
  });

  describe('complete', () => {
    it('transitions to COMPLETED when the token matches, refreshes TTL, stores response', async () => {
      const { token } = await storage.create('K1', 'fp', 10);
      const result = await storage.complete(
        'K1',
        token!,
        { statusCode: 201, body: '{"id":"abc"}' },
        3600,
      );
      expect(result).toBe('ok');

      const record = await storage.get('K1');
      expect(record!.status).toBe('COMPLETED');
      expect(record!.statusCode).toBe(201);
      expect(typeof record!.statusCode).toBe('number');
      expect(record!.responseBody).toBe('{"id":"abc"}');

      const ttl = await (client as any).ttl('idempotency:K1');
      expect(ttl).toBeGreaterThan(60);
      expect(ttl).toBeLessThanOrEqual(3600);
    });

    it('preserves createdAt across complete()', async () => {
      const { token } = await storage.create('K1', 'fp', 10);
      const created = await storage.get('K1');
      const originalCreatedAt = created!.createdAt;

      await new Promise((r) => setTimeout(r, 5));

      await storage.complete(
        'K1',
        token!,
        { statusCode: 200, body: '{}' },
        3600,
      );
      const completed = await storage.get('K1');
      expect(completed!.createdAt.getTime()).toBe(originalCreatedAt.getTime());
    });

    it('returns "stale" when the key does not exist', async () => {
      const result = await storage.complete(
        'missing',
        'some-token',
        { statusCode: 200, body: '{}' },
        60,
      );
      expect(result).toBe('stale');
    });

    it('returns "stale" when the token does not match', async () => {
      await storage.create('K1', 'fp', 10);
      const result = await storage.complete(
        'K1',
        'wrong-token',
        { statusCode: 200, body: '{}' },
        60,
      );
      expect(result).toBe('stale');

      // Verify the original record was NOT mutated.
      const record = await storage.get('K1');
      expect(record!.status).toBe('PROCESSING');
      expect(record!.responseBody).toBeUndefined();
    });

    it('passes through nested JSON bodies without double-encoding', async () => {
      const { token } = await storage.create('K1', 'fp', 10);
      const nested = '{"nested":{"a":1,"b":[2,3]}}';
      await storage.complete(
        'K1',
        token!,
        { statusCode: 200, body: nested },
        60,
      );
      const record = await storage.get('K1');
      expect(record!.responseBody).toBe(nested);
    });
  });

  describe('delete', () => {
    it('removes a record when the token matches', async () => {
      const { token } = await storage.create('K1', undefined, 10);
      const result = await storage.delete('K1', token!);
      expect(result).toBe('ok');
      await expect(storage.get('K1')).resolves.toBeNull();
    });

    it('returns "ok" for a missing key (idempotent cleanup)', async () => {
      const result = await storage.delete('missing', 'any-token');
      expect(result).toBe('ok');
    });

    it('returns "stale" when the token does not match and leaves the record intact', async () => {
      await storage.create('K1', 'fp', 10);
      const result = await storage.delete('K1', 'wrong-token');
      expect(result).toBe('stale');
      await expect(storage.get('K1')).resolves.not.toBeNull();
    });
  });

  describe('keyPrefix', () => {
    it('honors a custom prefix', async () => {
      const customStorage = new RedisStorage({
        client,
        keyPrefix: 'myapp:idem:',
      });
      await customStorage.create('K1', 'fp', 10);
      const hash = await (client as any).hgetall('myapp:idem:K1');
      expect(hash.token).toBeTruthy();
    });
  });

  describe('constructor accepts both client and connection options', () => {
    it('builds an internal Redis client from a connection options object', async () => {
      const storage2 = new RedisStorage({
        connection: { host: 'localhost', port: 6379 },
        // ioredis-mock's type signature doesn't accept connection options,
        // but the runtime constructor does. The cast is test-only.
        clientFactory: () => new (RedisMock as any)() as Redis,
      });
      const result = await storage2.create('Kx', 'fp', 10);
      expect(result.acquired).toBe(true);
      await storage2.close();
    });
  });
});
