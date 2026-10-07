/**
 * S5/S6 regression: delayed Memory timers and unswept Postgres rows allowed
 * an expired lease to complete, while Memory/Redis allowed a second complete
 * to overwrite a captured response and extend its TTL. Expiry is now logical
 * at expiresAt <= now, and only a live PROCESSING owner can complete once.
 * The exact boundary tests deliberately do not run timers or sweep rows first.
 */
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { Pool, type PoolClient } from 'pg';

import { MemoryStorage } from '../../src/storage/memory.storage';
import { RedisStorage } from '../../src/storage/redis.storage';
import { PostgresStorage } from '../../src/storage/postgres.storage';

describe('REGRESSION: Memory lease boundaries without timer eviction', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.onModuleDestroy();
    jest.useRealTimers();
  });

  it.each([-1, 0, 1])(
    'get/create at expiry offset %s ms follow the same boundary',
    async (offset) => {
      const old = await storage.create('get', 'old', 1);
      await storage.create('create', 'old', 1);
      jest.setSystemTime(Date.now() + 1000 + offset);
      const record = await storage.get('get');
      const created = await storage.create('create', 'new', 60);
      expect(record?.token ?? null).toBe(offset < 0 ? old.token : null);
      expect(created.acquired).toBe(offset >= 0);
    },
  );

  it.each([-1, 0, 1])(
    'complete at expiry offset %s ms cannot resurrect an expired lease',
    async (offset) => {
      const { token } = await storage.create('complete', 'old', 1);
      jest.setSystemTime(Date.now() + 1000 + offset);
      await expect(storage.complete('complete', token!, { statusCode: 201 }, 60)).resolves.toBe(
        offset < 0 ? 'ok' : 'stale',
      );
      if (offset >= 0) await expect(storage.get('complete')).resolves.toBeNull();
    },
  );

  it.each([-1, 0, 1])(
    'delete with a different token at expiry offset %s ms sees logical absence',
    async (offset) => {
      await storage.create('delete', 'old', 1);
      jest.setSystemTime(Date.now() + 1000 + offset);
      await expect(storage.delete('delete', 'wrong-token')).resolves.toBe(
        offset < 0 ? 'stale' : 'ok',
      );
    },
  );

  it('a repeated complete preserves the first response and retention window', async () => {
    const { token } = await storage.create('repeat', 'fp', 60);
    await storage.complete('repeat', token!, { statusCode: 201, body: 'first' }, 60);
    const first = await storage.get('repeat');
    jest.setSystemTime(Date.now() + 1000);
    await expect(
      storage.complete('repeat', token!, { statusCode: 500, body: 'second' }, 3600),
    ).resolves.toBe('stale');
    expect(await storage.get('repeat')).toEqual(first);
  });
});

describe('REGRESSION: Redis complete-once CAS', () => {
  it('two simultaneous completions with the same token cannot overwrite the first winner', async () => {
    const client = new RedisMock() as unknown as Redis;
    const storage = new RedisStorage({ client, keyPrefix: 'regression:s5:repeat:' });
    try {
      const { token } = await storage.create('key', 'fp', 60);
      const results = await Promise.all([
        storage.complete('key', token!, { statusCode: 201, body: 'one' }, 60),
        storage.complete('key', token!, { statusCode: 202, body: 'two' }, 3600),
      ]);
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'stale')).toHaveLength(1);
      const record = await storage.get('key');
      expect(record!.responseBody).toBe(results[0] === 'ok' ? 'one' : 'two');
    } finally {
      await client.del('regression:s5:repeat:key');
      await client.quit();
    }
  });
});

const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('REGRESSION: Postgres exact lease boundary without sweep', () => {
  const tableName = 'idempotency_s5_lifecycle_regression';
  let pool: Pool;
  let client: PoolClient;
  let storage: PostgresStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await PostgresStorage.createSchema(pool, tableName);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    // Postgres now() is stable within a transaction, making equality exact.
    await client.query('BEGIN');
    storage = new PostgresStorage({ pool: client as unknown as Pool, tableName });
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  const expire = async (key: string) => {
    await client.query(`UPDATE "${tableName}" SET expires_at = now() WHERE key = $1`, [key]);
  };

  it('get is absent and create acquires at expires_at = now()', async () => {
    await storage.create('key', 'old', 60);
    await expire('key');
    await expect(storage.get('key')).resolves.toBeNull();
    await expect(storage.create('key', 'new', 60)).resolves.toMatchObject({ acquired: true });
  });

  it('complete returns stale at expires_at = now() without a replacement', async () => {
    const { token } = await storage.create('key', 'old', 60);
    await expire('key');
    await expect(
      storage.complete('key', token!, { statusCode: 201, body: 'late' }, 60),
    ).resolves.toBe('stale');
    const row = await client.query(
      `SELECT status, response_body FROM "${tableName}" WHERE key = 'key'`,
    );
    expect(row.rows[0]).toEqual({ status: 'PROCESSING', response_body: null });
  });

  it.each(['00000000-0000-4000-8000-000000000000'])(
    'delete treats an expired row as absent for nonmatching token %s',
    async (token) => {
      await storage.create('key', 'old', 60);
      await expire('key');
      await expect(storage.delete('key', token)).resolves.toBe('ok');
    },
  );
});
