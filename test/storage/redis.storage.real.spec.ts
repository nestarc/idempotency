import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';

import { RedisStorage } from '../../src/storage/redis.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const REDIS_URL = process.env.TEST_REDIS_URL;
const describeOrSkip = REDIS_URL ? describe : describe.skip;

if (!REDIS_URL) {
  // eslint-disable-next-line no-console
  console.warn('[redis.storage.real.spec] TEST_REDIS_URL not set - real Redis tests skipped.');
}

describeOrSkip('RedisStorage real Redis', () => {
  const prefix = `idempotency:test:${randomUUID()}:`;

  describeStorageContract('RedisStorage real Redis', async () => {
    const client = new Redis(REDIS_URL!);
    const storage = new RedisStorage({ client, keyPrefix: prefix });
    return {
      storage,
      expire: async (key) => {
        await client.pexpire(`${prefix}${key}`, 0);
      },
      cleanup: async () => {
        const keys = await client.keys(`${prefix}*`);
        if (keys.length > 0) {
          await client.del(...keys);
        }
        await client.quit();
      },
    };
  });

  it('server TTL expiry rejects a late owner without a replacement', async () => {
    const client = new Redis(REDIS_URL!);
    const keyPrefix = `idempotency:expiry:${randomUUID()}:`;
    const storage = new RedisStorage({ client, keyPrefix });
    try {
      const { token } = await storage.create('key', 'fp', 1);
      const deadline = Date.now() + 3000;
      // Observe the Redis clock directly; a fixed sleep cannot establish expiry.
      while ((await client.pttl(`${keyPrefix}key`)) !== -2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await client.pttl(`${keyPrefix}key`)).toBe(-2);
      await expect(
        storage.complete('key', token!, { statusCode: 201, body: 'late' }, 60),
      ).resolves.toBe('stale');
      await expect(storage.get('key')).resolves.toBeNull();
    } finally {
      await client.del(`${keyPrefix}key`);
      await client.quit();
    }
  });

  it.each([30 * 24 * 60 * 60, 2_147_483_647])(
    'keeps the server TTL for long create and complete windows (%s seconds)',
    async (ttlSeconds) => {
      const client = new Redis(REDIS_URL!);
      const keyPrefix = `idempotency:long-ttl:${randomUUID()}:`;
      const storage = new RedisStorage({ client, keyPrefix });
      const key = `${keyPrefix}key`;
      // A round trip may consume time, but cannot shorten a multi-day TTL to
      // Node's timer range. Keep the same 1s tolerance as the shared contract.
      const expectServerTtl = async () => {
        const remaining = await client.pttl(key);
        expect(remaining).toBeGreaterThanOrEqual(ttlSeconds * 1000 - 1000);
        expect(remaining).toBeLessThanOrEqual(ttlSeconds * 1000);
      };
      try {
        const { token } = await storage.create('key', 'fp', ttlSeconds);
        await expectServerTtl();
        await expect(
          storage.complete('key', token!, { statusCode: 201, body: 'long retention' }, ttlSeconds),
        ).resolves.toBe('ok');
        await expectServerTtl();
        const beforeInvalid = await client.pttl(key);
        await expect(
          storage.complete('key', token!, { statusCode: 500 }, 2_147_483_648),
        ).rejects.toThrow(RangeError);
        expect(await client.pttl(key)).toBeLessThanOrEqual(beforeInvalid);
        expect((await storage.get('key'))!.responseBody).toBe('long retention');
      } finally {
        await client.del(key);
        await client.quit();
      }
    },
  );

  it('a repeated completion does not refresh the server retention TTL', async () => {
    const client = new Redis(REDIS_URL!);
    const keyPrefix = `idempotency:retention:${randomUUID()}:`;
    const storage = new RedisStorage({ client, keyPrefix });
    try {
      const { token } = await storage.create('key', 'fp', 60);
      await storage.complete('key', token!, { statusCode: 201, body: 'first' }, 60);
      const before = await client.pttl(`${keyPrefix}key`);
      await expect(
        storage.complete('key', token!, { statusCode: 202, body: 'second' }, 3600),
      ).resolves.toBe('stale');
      const after = await client.pttl(`${keyPrefix}key`);
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThanOrEqual(before);
    } finally {
      await client.del(`${keyPrefix}key`);
      await client.quit();
    }
  });
});
