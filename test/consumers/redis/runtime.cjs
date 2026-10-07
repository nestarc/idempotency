require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MemoryStorage } = require('@nestarc/idempotency');
const { RedisStorage } = require('@nestarc/idempotency/redis');
const Redis = require('ioredis');
const { assertAbsent, assertPublicPaths, bootAndSmoke, run } = require('./common/runtime.cjs');
const { runRedisExamples } = require('./compiled/examples');
const { verifyHttpStorageContract } = require('./compiled/common/http-contract');

run(async () => {
  assertAbsent('pg', '@types/pg/package.json');
  assertPublicPaths();
  assert.equal(typeof RedisStorage, 'function');
  if (process.env.CONSUMER_SKIP_SERVICES === '1') {
    await bootAndSmoke(new MemoryStorage(), 'redis consumer / memory bootstrap');
    console.log('SKIP real Redis adapter smoke: --skip-services selected');
    return;
  }
  assert.ok(process.env.TEST_REDIS_URL, 'Set TEST_REDIS_URL or explicitly use --skip-services');
  const client = new Redis(process.env.TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  client.on('error', (error) => console.error(`Redis consumer: ${error.message}`));
  const keyPrefix = `consumer-${randomUUID()}:`;
  try {
    await client.connect();
    const storage = new RedisStorage({ client, keyPrefix });
    await bootAndSmoke(storage, 'redis');
    await verifyHttpStorageContract(storage, 'redis');
    await runRedisExamples(client, keyPrefix, process.env.TEST_REDIS_URL);
  } finally {
    try {
      if (client.status === 'ready') {
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 100);
          cursor = next;
          if (keys.length) await client.del(...keys);
        } while (cursor !== '0');
      }
    } finally {
      try {
        if (client.status === 'ready') await client.quit();
      } finally {
        client.disconnect();
      }
    }
  }
});
