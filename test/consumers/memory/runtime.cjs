const assert = require('node:assert/strict');
const { assertAbsent, assertPublicPaths, bootAndSmoke, run } = require('./common/runtime.cjs');
const root = require('@nestarc/idempotency');
const { runMemoryExamples } = require('./compiled/examples');
const { verifyHttpStorageContract } = require('./compiled/common/http-contract');

run(async () => {
  assertAbsent('pg', 'ioredis', '@types/pg/package.json');
  assertPublicPaths();
  assert.equal(root.RedisStorage, undefined);
  assert.equal(root.PostgresStorage, undefined);
  assert.equal(root.PostgresSweepService, undefined);
  const { RedisStorage } = require('@nestarc/idempotency/redis');
  const { PostgresStorage, PostgresSweepService } = require('@nestarc/idempotency/postgres');
  assert.equal(typeof PostgresSweepService, 'function');
  assert.throws(
    () => new RedisStorage({ connection: {} }),
    /RedisStorage:.*ioredis.*npm install ioredis/s,
  );
  assert.throws(
    () => new PostgresStorage({ connection: {} }),
    /PostgresStorage:.*pg.*npm install pg/s,
  );
  console.log('PASS adapter import is lazy and missing-driver constructors explain installation');
  await bootAndSmoke(new root.MemoryStorage(), 'memory');
  await verifyHttpStorageContract(new root.MemoryStorage(), 'memory');
  await runMemoryExamples();
});
