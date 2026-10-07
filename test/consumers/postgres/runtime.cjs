require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MemoryStorage } = require('@nestarc/idempotency');
const { PostgresStorage, PostgresSweepService } = require('@nestarc/idempotency/postgres');
const { Pool } = require('pg');
const { assertAbsent, assertPublicPaths, bootAndSmoke, run } = require('./common/runtime.cjs');
const { runPostgresExamples } = require('./compiled/examples');
const { verifyHttpStorageContract } = require('./compiled/common/http-contract');

run(async () => {
  assertAbsent('ioredis');
  assertPublicPaths();
  assert.equal(typeof PostgresStorage, 'function');
  assert.equal(typeof PostgresSweepService, 'function');
  if (process.env.CONSUMER_SKIP_SERVICES === '1') {
    await bootAndSmoke(new MemoryStorage(), 'postgres consumer / memory bootstrap');
    console.log('SKIP real Postgres adapter smoke: --skip-services selected');
    return;
  }
  assert.ok(
    process.env.TEST_DATABASE_URL,
    'Set TEST_DATABASE_URL or explicitly use --skip-services',
  );
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    max: 1,
  });
  const tableName = `consumer_${randomUUID().replaceAll('-', '')}`;
  try {
    const storage = new PostgresStorage({ pool, tableName, autoCreateSchema: true });
    await bootAndSmoke(storage, 'postgres');
    await verifyHttpStorageContract(storage, 'postgres');
    await runPostgresExamples(pool, tableName, process.env.TEST_DATABASE_URL);
  } finally {
    try {
      await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } finally {
      await pool.end();
    }
  }
});
