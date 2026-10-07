/**
 * Sweep regressions must observe stored rows and real advisory-lock ownership.
 * A scheduled callback, a cleared private timer, or a mocked delete result alone
 * cannot prove that expired rows are removed and live work survives shutdown.
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { PostgresSweepService, type SweepOptions } from '../../src/services/postgres-sweep.service';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-run table isolation also protects concurrent Jest processes and local
// developers sharing the same test database from TRUNCATE/DROP interference.
// The sweep service reads `this.storage.tableName` internally, so passing
// the unique tableName into the storage flows through to the DELETE.
const TABLE_NAME = `test_pg_sweep_${randomUUID().replace(/-/g, '')}`;

describeOrSkip('PostgresSweepService', () => {
  let pool: Pool;
  let fixtureLock: PoolClient | undefined;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    // Serialize only real sweep fixtures: the production lock is deliberately
    // global, so unrelated Jest workers must not alter these contention scenarios.
    fixtureLock = await pool.connect();
    await fixtureLock.query("SELECT pg_advisory_lock(hashtext('idempotency-test-sweep-fixture'))");
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    } finally {
      try {
        if (fixtureLock) {
          await fixtureLock.query(
            "SELECT pg_advisory_unlock(hashtext('idempotency-test-sweep-fixture'))",
          );
        }
      } finally {
        fixtureLock?.release();
        await pool.end();
      }
    }
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE_NAME}"`);
  });

  const seed = async (key: string, expiresOffsetMs: number): Promise<void> => {
    await pool.query(
      `INSERT INTO "${TABLE_NAME}"
         (key, token, fingerprint, status, expires_at)
       VALUES ($1, gen_random_uuid(), 'fp', 'COMPLETED',
               now() + ($2 || ' milliseconds')::interval)`,
      [key, String(expiresOffsetMs)],
    );
  };

  const buildService = (opts?: Partial<SweepOptions>): PostgresSweepService => {
    const storage = new PostgresStorage({ pool, tableName: TABLE_NAME });
    return new PostgresSweepService(storage, {
      enabled: true,
      intervalMs: 60_000,
      ...opts,
    });
  };

  it('deletes only expired rows', async () => {
    await seed('expired-1', -1000);
    await seed('expired-2', -1000);
    await seed('active', 60_000);

    const svc = buildService();
    const result = await svc.sweep();
    expect(result.deleted).toBe(2);

    const remaining = await pool.query<{ key: string }>(
      `SELECT key FROM "${TABLE_NAME}" ORDER BY key`,
    );
    expect(remaining.rows.map((r) => r.key)).toEqual(['active']);
  });

  it('does nothing when there are no expired rows', async () => {
    await seed('active', 60_000);
    const svc = buildService();
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
  });

  it('disabled scheduling leaves expired rows until an explicit manual sweep', async () => {
    await seed('expired-manual', -1000);
    const svc = buildService({ enabled: false });
    const sweep = jest.spyOn(svc, 'sweep');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      await svc.onModuleInit();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(sweep).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      const before = await pool.query(`SELECT key FROM "${TABLE_NAME}"`);
      expect(before.rows).toEqual([{ key: 'expired-manual' }]);
      await expect(svc.sweep()).resolves.toEqual({ deleted: 1 });
      const after = await pool.query(`SELECT key FROM "${TABLE_NAME}"`);
      expect(after.rows).toEqual([]);
    } finally {
      await svc.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('scheduled sweeps delete expired rows and stop touching storage after destroy', async () => {
    await seed('expired-before-destroy', -1000);
    await seed('live', 60_000);
    const svc = buildService({ intervalMs: 1000 });
    const sweep = jest.spyOn(svc, 'sweep');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      await svc.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(1000);
      expect(sweep).toHaveBeenCalledTimes(1);
      await expect(sweep.mock.results[0].value).resolves.toEqual({ deleted: 1 });
      const beforeDestroy = await pool.query(`SELECT key FROM "${TABLE_NAME}"`);
      expect(beforeDestroy.rows).toEqual([{ key: 'live' }]);

      await svc.onModuleDestroy();
      await seed('expired-after-destroy', -1000);
      await jest.advanceTimersByTimeAsync(5000);
      expect(sweep).toHaveBeenCalledTimes(1);
      const afterDestroy = await pool.query(`SELECT key FROM "${TABLE_NAME}" ORDER BY key`);
      expect(afterDestroy.rows).toEqual([{ key: 'expired-after-destroy' }, { key: 'live' }]);
    } finally {
      await svc.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('lock contention preserves rows, then a later cycle can acquire and delete them', async () => {
    await seed('expired', -1000);
    const lockHolder = await pool.connect();
    try {
      await lockHolder.query("SELECT pg_advisory_lock(hashtext('idempotency-sweep'))");
      await expect(buildService().sweep()).resolves.toEqual({ deleted: 0 });
      expect((await pool.query(`SELECT key FROM "${TABLE_NAME}"`)).rows).toEqual([
        { key: 'expired' },
      ]);
    } finally {
      try {
        await lockHolder.query("SELECT pg_advisory_unlock(hashtext('idempotency-sweep'))");
      } finally {
        lockHolder.release();
      }
    }
    await expect(buildService().sweep()).resolves.toEqual({ deleted: 1 });
    expect((await pool.query(`SELECT key FROM "${TABLE_NAME}"`)).rows).toEqual([]);
  });

  it('a failed DELETE releases the session advisory lock for a separate connection', async () => {
    const missing = `${TABLE_NAME}_missing`;
    const storage = new PostgresStorage({ pool, tableName: missing });
    const svc = new PostgresSweepService(storage);
    await expect(svc.sweep()).rejects.toMatchObject({ code: '42P01' });
    // Exactly the fixture's coordination client remains checked out.
    expect(pool.totalCount - pool.idleCount).toBe(1);
    const observer = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
    const client = await observer.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('idempotency-sweep')) AS acquired",
      );
      expect(lock.rows).toEqual([{ acquired: true }]);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext('idempotency-sweep'))");
      } finally {
        client.release();
        await observer.end();
      }
    }
    // Pool checkout also succeeds after the failing cycle released its client.
    await seed('expired-after-failure', -1000);
    await expect(buildService().sweep()).resolves.toEqual({ deleted: 1 });
  });
});
