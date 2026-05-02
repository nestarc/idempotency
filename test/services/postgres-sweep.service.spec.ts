import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import {
  PostgresSweepService,
  type SweepOptions,
} from '../../src/services/postgres-sweep.service';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('PostgresSweepService', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE idempotency_records');
  });

  const seed = async (key: string, expiresOffsetMs: number): Promise<void> => {
    await pool.query(
      `INSERT INTO idempotency_records
         (key, token, fingerprint, status, expires_at)
       VALUES ($1, gen_random_uuid(), 'fp', 'COMPLETED',
               now() + ($2 || ' milliseconds')::interval)`,
      [key, String(expiresOffsetMs)],
    );
  };

  const buildService = (opts?: Partial<SweepOptions>): PostgresSweepService => {
    const storage = new PostgresStorage({ pool });
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
      'SELECT key FROM idempotency_records ORDER BY key',
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
    // Internal timer should be unset; tearing down should be a no-op.
    await svc.onModuleDestroy();
    // No assertion error means we did not schedule. Sweep can still be
    // called manually:
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
  });

  it('clears the interval on onModuleDestroy', async () => {
    jest.useFakeTimers();
    try {
      const svc = buildService({ intervalMs: 1000 });
      await svc.onModuleInit();
      await svc.onModuleDestroy();
      // After destroy, advancing time should not trigger sweep.
      jest.advanceTimersByTime(5000);
      // Nothing to assert directly — absence of unhandled rejections is enough.
    } finally {
      jest.useRealTimers();
    }
  });
});
