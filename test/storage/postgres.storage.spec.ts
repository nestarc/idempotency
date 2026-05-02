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
