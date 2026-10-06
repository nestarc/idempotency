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
    const created = await storage.create(key, 'consumer-fingerprint', 60);
    assert.equal(created.acquired, true);
    assert.equal(typeof created.token, 'string');
    token = created.token;
    const processing = await storage.get(key);
    assert.equal(processing.status, 'PROCESSING');
    assert.equal(processing.token, token);
    assert.equal(processing.fingerprint, 'consumer-fingerprint');
    assert.equal((await storage.create(key, 'consumer-fingerprint', 60)).acquired, false);
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
    assert.equal(await storage.delete(key, token), 'ok');
    assert.equal(await storage.get(key), null);
    console.log(`PASS ${label} create/get/complete/delete`);
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
