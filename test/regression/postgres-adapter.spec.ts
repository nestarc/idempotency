/**
 * Re-runs the storage-sensitive subset of the v0.1.3 regression suite
 * against a real PostgresStorage. The interceptor-level regressions that
 * use FakeStorage stay untouched — they exercise the interceptor itself,
 * not adapter semantics.
 *
 * This file pins down two adapter-level invariants:
 *   1. Token CAS holds across `complete()` after TTL eviction.
 *   2. Two concurrent `create()` calls under contention yield exactly
 *      one acquired:true and one acquired:false (NX semantics).
 */
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('PostgresStorage v0.1.3 regression parity', () => {
  let pool: Pool;
  let storage: PostgresStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE idempotency_records');
    storage = new PostgresStorage({ pool });
  });

  it('race-completed-winner: complete() after expired-replacement returns stale', async () => {
    const { token: oldToken } = await storage.create('rk', 'fp', 60);

    // Force the row to be expired so a fresh create() can replace it.
    await pool.query(
      `UPDATE idempotency_records SET expires_at = now() - interval '1 second'
       WHERE key = 'rk'`,
    );

    const second = await storage.create('rk', 'fp', 60);
    expect(second.acquired).toBe(true);
    expect(second.token).not.toBe(oldToken);

    // The original caller's complete() must report stale — they no longer
    // own the row.
    const stale = await storage.complete(
      'rk',
      oldToken!,
      { statusCode: 200, body: '{}' },
      60,
    );
    expect(stale).toBe('stale');

    // The new owner can still complete normally.
    const ok = await storage.complete(
      'rk',
      second.token!,
      { statusCode: 200, body: '{}' },
      60,
    );
    expect(ok).toBe('ok');
  });

  it('NX semantics under concurrent creation: exactly one wins', async () => {
    const results = await Promise.all([
      storage.create('cc', 'fp1', 60),
      storage.create('cc', 'fp2', 60),
      storage.create('cc', 'fp3', 60),
      storage.create('cc', 'fp4', 60),
      storage.create('cc', 'fp5', 60),
    ]);

    const winners = results.filter((r) => r.acquired);
    const losers = results.filter((r) => !r.acquired);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);

    const row = await storage.get('cc');
    expect(row!.token).toBe(winners[0].token);
  });
});
