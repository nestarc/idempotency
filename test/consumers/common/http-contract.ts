import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Module, Post, UseInterceptors } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  IdempotencyInterceptor,
  IdempotencyModule,
  Idempotent,
  type IdempotencyStorage,
} from '@nestarc/idempotency';

/** Exercise the installed interceptor with the installed adapter, through real TCP. */
export async function verifyHttpStorageContract(
  storage: IdempotencyStorage,
  label: string,
): Promise<void> {
  let calls = 0;
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  @Controller('commands')
  @UseInterceptors(IdempotencyInterceptor)
  class CommandsController {
    @Post()
    @Idempotent()
    async create(@Body() body: { amount: number }): Promise<{ amount: number; receipt: number }> {
      calls += 1;
      const receipt = calls;
      enter();
      await held;
      return { amount: body.amount, receipt };
    }
  }
  @Module({
    imports: [IdempotencyModule.forRoot({ storage, ttl: 60, processingTtl: 30 })],
    controllers: [CommandsController],
  })
  class ConsumerModule {}
  const app = await NestFactory.create(ConsumerModule, { logger: false, abortOnError: false });
  let first: Promise<Response> | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await app.init();
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/commands`;
    const key = `consumer-http-${randomUUID()}`;
    const request = (amount: number, commandKey = key) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': commandKey },
        body: JSON.stringify({ amount }),
        signal: AbortSignal.timeout(5000),
      });
    first = request(100);
    // Register a handler immediately so a connection failure cannot become unhandled
    // while waiting for the application handler to announce that it is in flight.
    void first.catch(() => {});
    await Promise.race([
      entered,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label}: handler did not start`)), 5000);
      }),
    ]);
    clearTimeout(timeout);
    const conflict = await request(100);
    assert.equal(conflict.status, 409, `${label}: concurrent processing request must conflict`);
    assert.equal(conflict.headers.get('idempotency-status'), 'conflict');
    await conflict.text();
    const mismatch = await request(101);
    assert.equal(mismatch.status, 422, `${label}: changed payload must not execute`);
    assert.equal(mismatch.headers.get('idempotency-status'), 'mismatch');
    await mismatch.text();
    assert.equal(calls, 1, `${label}: rejected requests cannot invoke the handler`);
    release();
    const created = await first;
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('idempotency-status'), 'created');
    const body = await created.text();
    assert.deepEqual(JSON.parse(body), { amount: 100, receipt: 1 });
    const replays = await Promise.all(Array.from({ length: 4 }, () => request(100)));
    for (const response of replays) {
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('idempotency-status'), 'replayed');
      assert.equal(response.headers.get('content-type'), created.headers.get('content-type'));
      assert.equal(await response.text(), body, `${label}: replay preserves the first response`);
    }
    assert.equal(calls, 1, `${label}: completed replays must not invoke the handler`);
    const independent = await request(100, `${key}-independent`);
    assert.equal(independent.status, 201);
    assert.equal(independent.headers.get('idempotency-status'), 'created');
    assert.deepEqual(await independent.json(), { amount: 100, receipt: 2 });
    assert.equal(calls, 2, `${label}: a new key still invokes the handler`);
  } finally {
    clearTimeout(timeout);
    release();
    if (first)
      await first
        .then(
          (response) => response.body?.cancel(),
          () => {},
        )
        .catch(() => {});
    await app.close();
  }
  console.log(
    `PASS ${label} real HTTP processing conflict/mismatch/concurrent replay/handler effects`,
  );
}
