import Redis from 'ioredis';
import { randomUUID } from 'crypto';

import { RedisStorage } from '../../src/storage/redis.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const REDIS_URL = process.env.TEST_REDIS_URL;
const describeOrSkip = REDIS_URL ? describe : describe.skip;

const createClient = () =>
  new Redis(REDIS_URL!, {
    connectTimeout: 2000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });

async function cleanupClient(client: Redis, prefix: string): Promise<void> {
  try {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== '0');
  } finally {
    try {
      if (client.status !== 'end') await client.quit();
    } finally {
      client.disconnect();
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

if (!REDIS_URL) {
  // eslint-disable-next-line no-console
  console.warn('[redis.storage.real.spec] TEST_REDIS_URL not set - real Redis tests skipped.');
}

describeOrSkip('RedisStorage real Redis', () => {
  describeStorageContract('RedisStorage real Redis', async () => {
    const prefix = `idempotency:test:${randomUUID()}:`;
    const client = createClient();
    const storage = new RedisStorage({ client, keyPrefix: prefix });
    return {
      storage,
      expire: async (key) => {
        await client.pexpire(`${prefix}${key}`, 0);
      },
      cleanup: async () => cleanupClient(client, prefix),
    };
  });

  it('server TTL expiry rejects a late owner without a replacement', async () => {
    const client = createClient();
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
      await cleanupClient(client, keyPrefix);
    }
  });

  it.each([30 * 24 * 60 * 60, 2_147_483_647])(
    'keeps the server TTL for long create and complete windows (%s seconds)',
    async (ttlSeconds) => {
      const client = createClient();
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
        await cleanupClient(client, keyPrefix);
      }
    },
  );

  it.each(['completed', 'replaced'] as const)(
    'Lua refuses a stale snapshot when another client has %s the lease after the read',
    async (change) => {
      const client = createClient();
      const rivalClient = createClient();
      const prefix = `idempotency:cas-window:${randomUUID()}:`;
      const storage = new RedisStorage({ client, keyPrefix: prefix });
      const rival = new RedisStorage({ client: rivalClient, keyPrefix: prefix });
      const snapshotRead = deferred();
      const resumeComplete = deferred();
      let pending: Promise<'ok' | 'stale'> | undefined;
      const readHash = client.hgetall.bind(client);
      const readSpy = jest.spyOn(client, 'hgetall');
      try {
        const { token } = await storage.create('key', 'original', 60);
        // Pause only the transport return after Redis has answered HGETALL.
        // Both the rival operation and the resumed CAS still execute real Lua.
        readSpy.mockImplementationOnce(async (key) => {
          const snapshot = await readHash(key);
          snapshotRead.resolve();
          await resumeComplete.promise;
          return snapshot;
        });
        pending = storage.complete('key', token!, { statusCode: 202, body: 'loser' }, 3600);
        await Promise.race([
          snapshotRead.promise,
          pending.then(() => {
            throw new Error('Completion did not pause at the read gate');
          }),
        ]);

        let winnerToken = token!;
        if (change === 'replaced') {
          await rivalClient.pexpire(`${prefix}key`, 0);
          const replacement = await rival.create('key', 'replacement', 120);
          expect(replacement.acquired).toBe(true);
          expect(replacement.token).not.toBe(token);
          winnerToken = replacement.token!;
        }
        await expect(
          rival.complete(
            'key',
            winnerToken,
            {
              statusCode: 201,
              body: 'winner',
              headers: { location: '/winner' },
            },
            120,
          ),
        ).resolves.toBe('ok');
        const before = structuredClone(await rival.get('key'));
        const ttlBefore = await rivalClient.pttl(`${prefix}key`);

        resumeComplete.resolve();
        await expect(pending).resolves.toBe('stale');
        expect(await rival.get('key')).toEqual(before);
        expect(await rivalClient.pttl(`${prefix}key`)).toBeLessThanOrEqual(ttlBefore);
        expect(await rivalClient.pttl(`${prefix}key`)).toBeGreaterThan(0);
      } finally {
        resumeComplete.resolve();
        await pending?.catch(() => undefined);
        readSpy.mockRestore();
        try {
          await cleanupClient(client, prefix);
        } finally {
          try {
            await rivalClient.quit();
          } finally {
            rivalClient.disconnect();
          }
        }
      }
    },
  );

  it('close terminates an owned real client but keeps a consumer client usable', async () => {
    const owned = createClient();
    const consumer = createClient();
    const ownedStorage = new RedisStorage({ connection: {}, clientFactory: () => owned });
    const consumerStorage = new RedisStorage({ client: consumer });
    try {
      await expect(owned.ping()).resolves.toBe('PONG');
      await expect(consumer.ping()).resolves.toBe('PONG');
      await ownedStorage.close();
      await expect(owned.ping()).rejects.toThrow(/closed/);
      await consumerStorage.close();
      await expect(consumer.ping()).resolves.toBe('PONG');
    } finally {
      owned.disconnect();
      try {
        await consumer.quit();
      } finally {
        consumer.disconnect();
      }
    }
  });

  it('a repeated completion does not refresh the server retention TTL', async () => {
    const client = createClient();
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
      await cleanupClient(client, keyPrefix);
    }
  });
});
