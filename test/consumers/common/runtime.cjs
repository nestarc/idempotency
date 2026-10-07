require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { IdempotencyModule, IDEMPOTENCY_STORAGE } = require('@nestarc/idempotency');

function assertAbsent(...packages) {
  for (const name of packages) {
    assert.throws(
      () => require.resolve(name),
      (error) => error.code === 'MODULE_NOT_FOUND',
      `${name} must not be installed in this consumer`,
    );
  }
  console.log(`PASS unselected dependencies absent: ${packages.join(', ')}`);
}

function assertPublicPaths() {
  assert.ok(existsSync(require.resolve('@nestarc/idempotency/sql/init.sql')));
  assert.equal(require('@nestarc/idempotency/package.json').name, '@nestarc/idempotency');
  for (const path of ['dist/index.js', 'dist/storage/memory.storage', 'src/index']) {
    assert.throws(
      () => require(`@nestarc/idempotency/${path}`),
      (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  }
  console.log('PASS official assets resolve and private package paths are blocked');
}

async function storageSmoke(storage, label) {
  const key = `consumer-${randomUUID()}`;
  let token;
  try {
    assert.equal(await storage.get(key), null);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => storage.create(key, 'consumer-fingerprint', 60)),
    );
    const winners = attempts.filter((attempt) => attempt.acquired);
    assert.equal(winners.length, 1, `${label}: concurrent NX create must have one owner`);
    token = winners[0].token;
    assert.equal(typeof token, 'string');
    assert.ok(token.length > 0);
    for (const loser of attempts.filter((attempt) => !attempt.acquired)) {
      assert.equal(loser.token, undefined, 'a losing creator must not receive ownership');
    }
    const processing = await storage.get(key);
    assert.equal(processing.status, 'PROCESSING');
    assert.equal(processing.token, token);
    assert.equal(processing.fingerprint, 'consumer-fingerprint');
    assert.equal((await storage.create(key, 'changed-fingerprint', 60)).acquired, false);
    const staleToken = randomUUID();
    assert.notEqual(staleToken, token, 'stale-owner probe must use a different valid UUID');
    assert.equal(
      await storage.complete(key, staleToken, { statusCode: 500, body: 'wrong owner' }, 60),
      'stale',
    );
    assert.equal(await storage.delete(key, staleToken), 'stale');
    assert.deepEqual(await storage.get(key), processing, 'stale callers cannot mutate the owner');
    const createdAt = processing.createdAt.getTime();
    const body = '{"consumer":"opaque response"}';
    const headers = { 'content-type': 'application/json' };
    assert.equal(await storage.complete(key, token, { statusCode: 201, body, headers }, 60), 'ok');
    const completed = await storage.get(key);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.statusCode, 201);
    assert.equal(completed.responseBody, body);
    assert.deepEqual(completed.responseHeaders, headers);
    assert.equal(completed.createdAt.getTime(), createdAt);
    assert.equal(
      await storage.complete(key, token, { statusCode: 202, body: 'overwrite' }, 120),
      'stale',
    );
    assert.deepEqual(await storage.get(key), completed, 'complete-once preserves response and TTL');
    await assert.rejects(storage.complete(key, token, { statusCode: 500 }, 0), RangeError);
    assert.deepEqual(
      await storage.get(key),
      completed,
      'invalid TTL cannot mutate a completed record',
    );
    assert.equal(await storage.delete(key, token), 'ok');
    assert.equal(await storage.get(key), null);
    console.log(`PASS ${label} concurrent NX/ownership/complete-once/TTL/create/get/delete`);
  } finally {
    if (token) await storage.delete(key, token);
  }
}

async function bootAndSmoke(storage, label) {
  class ConsumerModule {}
  Module({ imports: [IdempotencyModule.forRoot({ storage, ttl: 60 })] })(ConsumerModule);
  const app = await NestFactory.create(ConsumerModule, { logger: false, abortOnError: false });
  try {
    await app.init();
    assert.equal(app.get(IDEMPOTENCY_STORAGE), storage);
    await storageSmoke(storage, label);
  } finally {
    await app.close();
  }
  console.log(`PASS ${label} NestFactory.create/init/close`);
}

function run(main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { assertAbsent, assertPublicPaths, bootAndSmoke, run, storageSmoke };
