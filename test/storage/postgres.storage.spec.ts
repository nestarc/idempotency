import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// A fresh namespace also isolates concurrent Jest processes and interrupted runs.
// Keep the generated supporting index name below PostgreSQL's 63-byte limit.
const TABLE_NAME = `idem_contract_${randomUUID().replace(/-/g, '')}`;

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
    suitePool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
    });
    await PostgresStorage.createSchema(suitePool, TABLE_NAME);
  });

  afterAll(async () => {
    try {
      await suitePool?.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    } finally {
      await suitePool?.end();
    }
  });

  describeStorageContract('PostgresStorage', async () => {
    // Per-test isolation: TRUNCATE before each test.
    await suitePool.query(`TRUNCATE "${TABLE_NAME}"`);
    const storage = new PostgresStorage({ pool: suitePool, tableName: TABLE_NAME });
    return {
      storage,
      expire: async (key) => {
        await suitePool.query(`UPDATE "${TABLE_NAME}" SET expires_at = now() WHERE key = $1`, [
          key,
        ]);
      },
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
    pool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
    });
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    try {
      await pool?.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    } finally {
      await pool?.end();
    }
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
         (key, token, fingerprint, status, response_code, response_body, response_headers, expires_at)
       VALUES ('expired-key', gen_random_uuid(), 'old-fp', 'COMPLETED',
               200, '{"prior":"body"}', '{"x-old":"1"}'::jsonb, now() - interval '1 second')`,
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
    expect(row!.responseHeaders).toBeUndefined();
  });

  it('createSchema() creates the response_headers JSONB column', async () => {
    await PostgresStorage.createSchema(pool, TABLE_NAME);

    const result = await pool.query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'response_headers'`,
      [TABLE_NAME],
    );

    expect(result.rows).toEqual([{ data_type: 'jsonb' }]);
  });

  it('createSchema() preserves existing replay records and the unique key constraint', async () => {
    const storage = new PostgresStorage({ pool, tableName: TABLE_NAME });
    const { token } = await storage.create('schema-preserved', 'fp', 60);
    await storage.complete('schema-preserved', token!, { statusCode: 201, body: 'original' }, 60);
    const before = structuredClone(await storage.get('schema-preserved'));

    await PostgresStorage.createSchema(pool, TABLE_NAME);
    await PostgresStorage.createSchema(pool, TABLE_NAME);

    expect(await storage.get('schema-preserved')).toEqual(before);
    await expect(storage.create('schema-preserved', 'replacement', 60)).resolves.toEqual({
      acquired: false,
    });
    const next = await storage.create('schema-new', 'new', 60);
    expect(next.acquired).toBe(true);
    expect((await storage.get('schema-new'))!.token).toBe(next.token);
  });

  it('createSchema() rejects unsafe table names', async () => {
    await expect(PostgresStorage.createSchema(pool, 'evil; DROP TABLE x;--')).rejects.toThrow(
      /invalid identifier/,
    );
  });

  it('honors a custom tableName option (creates and uses an alternate table)', async () => {
    const altTable = `idem_alt_${randomUUID().replace(/-/g, '')}`;
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
      const { token } = await storage.create('auto-created', 'fp', 60);
      await expect(
        storage.complete('auto-created', token!, { statusCode: 201, body: 'usable' }, 60),
      ).resolves.toBe('ok');
      expect(await storage.get('auto-created')).toMatchObject({
        token,
        status: 'COMPLETED',
        responseBody: 'usable',
      });
    } finally {
      // Restore the suite's table even on assertion failure so the next test
      // (or the next jest run after a failed run) starts from a known state.
      await PostgresStorage.createSchema(pool, TABLE_NAME);
    }
  });
});
