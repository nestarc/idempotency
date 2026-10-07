/**
 * S6 regression: direct adapter calls previously let invalid TTLs reach the
 * driver, or silently accepted them for missing/stale records. Validation
 * must reject before any lookup or command, independent of record ownership.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { MemoryStorage } from '../../src/storage/memory.storage';
import { RedisStorage } from '../../src/storage/redis.storage';
import { PostgresStorage } from '../../src/storage/postgres.storage';

describe('REGRESSION: invalid Memory TTL does not clean up an expired record', () => {
  it('rejects create and complete before clearing the pending eviction timer', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    const storage = new MemoryStorage();
    try {
      const { token } = await storage.create('expired', 'fp', 1);
      expect(jest.getTimerCount()).toBe(1);
      // Move only the logical clock: the record and eviction timer still exist.
      jest.setSystemTime(Date.now() + 1000);
      await expect(storage.create('expired', 'replacement', 0)).rejects.toThrow(RangeError);
      expect(jest.getTimerCount()).toBe(1);
      await expect(storage.complete('expired', token!, { statusCode: 200 }, 0)).rejects.toThrow(
        RangeError,
      );
      expect(jest.getTimerCount()).toBe(1);
    } finally {
      await storage.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});

describe('REGRESSION: invalid storage TTL never reaches an external client', () => {
  it.each(['create', 'complete'] as const)(
    'Redis %s rejects before any command',
    async (method) => {
      const client = {
        defineCommand: jest.fn(),
        hgetall: jest.fn().mockResolvedValue({}),
        idemCreate: jest.fn().mockResolvedValue(1),
        idemComplete: jest.fn().mockResolvedValue('ok'),
        idemDelete: jest.fn().mockResolvedValue('ok'),
      };
      const storage = new RedisStorage({ client: client as unknown as Redis });
      const operation =
        method === 'create'
          ? storage.create('key', 'fp', 0)
          : storage.complete('key', 'token', { statusCode: 200 }, 0);

      await expect(operation).rejects.toThrow(RangeError);
      expect(client.hgetall).not.toHaveBeenCalled();
      expect(client.idemCreate).not.toHaveBeenCalled();
      expect(client.idemComplete).not.toHaveBeenCalled();
      expect(client.idemDelete).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'complete'] as const)(
    'Postgres %s rejects before any query',
    async (method) => {
      const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
      const storage = new PostgresStorage({ pool: pool as unknown as Pool });
      const operation =
        method === 'create'
          ? storage.create('key', 'fp', 0)
          : storage.complete('key', 'token', { statusCode: 200 }, 0);

      await expect(operation).rejects.toThrow(RangeError);
      expect(pool.query).not.toHaveBeenCalled();
    },
  );
});
