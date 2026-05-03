import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import {
  PostgresSweepService,
  type SweepOptions,
} from '../../src/services/postgres-sweep.service';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: jest runs spec files in parallel; each PG spec
// uses its own table so TRUNCATEs cannot stomp on a sibling spec mid-test.
// The sweep service reads `this.storage.tableName` internally, so passing
// the unique tableName into the storage flows through to the DELETE.
const TABLE_NAME = 'idempotency_records_sweep';

describeOrSkip('PostgresSweepService', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await pool.end();
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

  it('disabled service does NOT schedule a timer on init', async () => {
    const svc = buildService({ enabled: false });
    await svc.onModuleInit();
    // Direct introspection: the internal timer field must be undefined.
    expect((svc as unknown as { timer: NodeJS.Timeout | undefined }).timer).toBeUndefined();
    await svc.onModuleDestroy();
    // Manual sweep should still work even when scheduling is disabled.
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
  });

  it('clears the interval on onModuleDestroy', async () => {
    jest.useFakeTimers();
    try {
      const svc = buildService({ intervalMs: 1000 });
      await svc.onModuleInit();
      const internal = svc as unknown as { timer?: NodeJS.Timeout };
      expect(internal.timer).toBeDefined();

      await svc.onModuleDestroy();
      // Advancing time after destroy must not trigger sweep. The timer
      // reference is left intact (we just clearInterval'd it), so we
      // verify quiescence via Jest's pending-timer count semantics.
      jest.advanceTimersByTime(5000);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
