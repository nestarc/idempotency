import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

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
    await PostgresStorage.createSchema(suitePool);
  });

  afterAll(async () => {
    await suitePool.end();
  });

  describeStorageContract('PostgresStorage', async () => {
    // Per-test isolation: TRUNCATE before each test.
    await suitePool.query('TRUNCATE idempotency_records');
    const storage = new PostgresStorage({ pool: suitePool });
    return {
      storage,
      cleanup: async () => {
        // Don't call storage.close() here — the consumer-supplied pool is
        // reused across tests. afterAll() ends it once at the end.
        await suitePool.query('TRUNCATE idempotency_records');
      },
    };
  });
});

describeOrSkip('PostgresStorage — Postgres-specific behavior', () => {
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

  it('create() replaces an expired row with a fresh PROCESSING record', async () => {
    const storage = new PostgresStorage({ pool });
    // Insert a row that is already expired by 1 second.
    await pool.query(
      `INSERT INTO idempotency_records
         (key, token, fingerprint, status, expires_at)
       VALUES ('expired-key', gen_random_uuid(), 'old-fp', 'COMPLETED',
               now() - interval '1 second')`,
    );

    const result = await storage.create('expired-key', 'new-fp', 60);
    expect(result.acquired).toBe(true);
    expect(typeof result.token).toBe('string');

    const row = await storage.get('expired-key');
    expect(row!.status).toBe('PROCESSING');
    expect(row!.fingerprint).toBe('new-fp');
    expect(row!.token).toBe(result.token);
  });

  it('createSchema() is idempotent — calling twice does not throw', async () => {
    await PostgresStorage.createSchema(pool);
    await PostgresStorage.createSchema(pool); // would throw on duplicate without IF NOT EXISTS
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

      // Default table should be untouched.
      const main = await pool.query(
        'SELECT count(*)::int AS c FROM idempotency_records WHERE key = $1',
        ['alt-key'],
      );
      expect(main.rows[0].c).toBe(0);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${altTable}"`);
    }
  });

  it('autoCreateSchema=true creates the table on module init when missing', async () => {
    // Drop the default table to simulate a fresh DB.
    await pool.query('DROP TABLE IF EXISTS idempotency_records');
    const storage = new PostgresStorage({ pool, autoCreateSchema: true });
    await storage.onModuleInit();

    const exists = await pool.query<{ to_regclass: string | null }>(
      `SELECT to_regclass('idempotency_records') AS to_regclass`,
    );
    expect(exists.rows[0].to_regclass).toBe('idempotency_records');

    // Re-create the schema for the rest of the suite.
    await PostgresStorage.createSchema(pool);
  });
});
