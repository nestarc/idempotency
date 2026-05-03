import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: jest runs spec files in parallel, so every PG
// spec uses its own table to avoid TRUNCATEs colliding across files. See
// Task 16 of the v0.2.0 plan for the rationale.
const TABLE_NAME = 'idempotency_records_contract';

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[postgres.storage.spec] TEST_DATABASE_URL not set — Postgres tests skipped.\n' +
      '  To run: docker compose up -d postgres && \\\n' +
      '          export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test',
  );
}

describeOrSkip('PostgresStorage', () => {
  let suitePool: Pool;

  beforeAll(async () => {
    suitePool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(suitePool, TABLE_NAME);
  });

  afterAll(async () => {
    await suitePool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await suitePool.end();
  });

  describeStorageContract('PostgresStorage', async () => {
    // Per-test isolation: TRUNCATE before each test.
    await suitePool.query(`TRUNCATE "${TABLE_NAME}"`);
    const storage = new PostgresStorage({ pool: suitePool, tableName: TABLE_NAME });
    return {
      storage,
      cleanup: async () => {
        // Don't call storage.close() here — the consumer-supplied pool is
        // reused across tests. afterAll() ends it once at the end.
        await suitePool.query(`TRUNCATE "${TABLE_NAME}"`);
      },
    };
  });
});

describeOrSkip('PostgresStorage — Postgres-specific behavior', () => {
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

  it('create() replaces an expired row with a fresh PROCESSING record', async () => {
    const storage = new PostgresStorage({ pool, tableName: TABLE_NAME });
    // Seed a COMPLETED row with non-null statusCode/body so we can assert
    // they are cleared by the ON CONFLICT DO UPDATE branch.
    await pool.query(
      `INSERT INTO "${TABLE_NAME}"
         (key, token, fingerprint, status, response_code, response_body, expires_at)
       VALUES ('expired-key', gen_random_uuid(), 'old-fp', 'COMPLETED',
               200, '{"prior":"body"}', now() - interval '1 second')`,
    );

    const result = await storage.create('expired-key', 'new-fp', 60);
    expect(result.acquired).toBe(true);
    expect(typeof result.token).toBe('string');

    const row = await storage.get('expired-key');
    expect(row!.status).toBe('PROCESSING');
    expect(row!.fingerprint).toBe('new-fp');
    expect(row!.token).toBe(result.token);
    // Cleared on replacement (was 200 / '{"prior":"body"}' before).
    expect(row!.statusCode).toBeUndefined();
    expect(row!.responseBody).toBeUndefined();
  });

  it('createSchema() is idempotent — calling twice does not throw', async () => {
    await PostgresStorage.createSchema(pool, TABLE_NAME);
    await PostgresStorage.createSchema(pool, TABLE_NAME); // would throw on duplicate without IF NOT EXISTS
  });

  it('createSchema() rejects unsafe table names', async () => {
    await expect(
      PostgresStorage.createSchema(pool, 'evil; DROP TABLE x;--'),
    ).rejects.toThrow(/invalid identifier/);
  });

  it('honors a custom tableName option (creates and uses an alternate table)', async () => {
    const altTable = 'idempotency_alt';
    await PostgresStorage.createSchema(pool, altTable);
    try {
      const storage = new PostgresStorage({ pool, tableName: altTable });
      const created = await storage.create('alt-key', 'fp', 60);
      expect(created.acquired).toBe(true);
      const row = await storage.get('alt-key');
      expect(row!.fingerprint).toBe('fp');

      // Suite's main table should be untouched.
      const main = await pool.query(
        `SELECT count(*)::int AS c FROM "${TABLE_NAME}" WHERE key = $1`,
        ['alt-key'],
      );
      expect(main.rows[0].c).toBe(0);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${altTable}"`);
    }
  });

  it('autoCreateSchema=true creates the table on module init when missing', async () => {
    // Drop our suite-private table to simulate a fresh DB.
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    try {
      const storage = new PostgresStorage({
        pool,
        tableName: TABLE_NAME,
        autoCreateSchema: true,
      });
      await storage.onModuleInit();

      const exists = await pool.query<{ to_regclass: string | null }>(
        `SELECT to_regclass($1) AS to_regclass`,
        [TABLE_NAME],
      );
      expect(exists.rows[0].to_regclass).toBe(TABLE_NAME);
    } finally {
      // Restore the suite's table even on assertion failure so the next test
      // (or the next jest run after a failed run) starts from a known state.
      await PostgresStorage.createSchema(pool, TABLE_NAME);
    }
  });
});
