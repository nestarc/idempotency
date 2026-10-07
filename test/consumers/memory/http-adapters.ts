import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Body, Controller, Module, Post, UseInterceptors } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  IdempotencyInterceptor,
  IdempotencyModule,
  Idempotent,
  MemoryStorage,
} from '@nestarc/idempotency';

/** Real TCP requests prove both HTTP adapters work with this installed tarball. */
export async function runHttpAdapter(name: 'express' | 'fastify'): Promise<void> {
  let calls = 0;
  @Controller('commands')
  @UseInterceptors(IdempotencyInterceptor)
  class CommandsController {
    @Post()
    @Idempotent()
    create(@Body() body: { amount: number }): { amount: number; accepted: boolean } {
      calls += 1;
      return { amount: body.amount, accepted: true };
    }
  }

  @Module({
    imports: [IdempotencyModule.forRoot({ storage: new MemoryStorage(), ttl: 60 })],
    controllers: [CommandsController],
  })
  class ConsumerModule {}

  const options = { logger: false as const, abortOnError: false };
  // NestFactory's default HTTP platform is the explicitly pinned platform-express.
  const app =
    name === 'express'
      ? await NestFactory.create(ConsumerModule, options)
      : await NestFactory.create(ConsumerModule, new FastifyAdapter(), options);
  try {
    await app.init();
    assert.equal(app.getHttpAdapter().getType(), name);
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/commands`;
    const request = (amount: number) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'adapter-command' },
        body: JSON.stringify({ amount }),
        signal: AbortSignal.timeout(5000),
      });
    const created = await request(100);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('idempotency-status'), 'created');
    const body = await created.text();
    assert.deepEqual(JSON.parse(body), { amount: 100, accepted: true });
    assert.equal(calls, 1);
    const replayed = await request(100);
    assert.equal(replayed.status, 201);
    assert.equal(replayed.headers.get('idempotency-status'), 'replayed');
    assert.equal(replayed.headers.get('content-type'), created.headers.get('content-type'));
    assert.equal(await replayed.text(), body);
    const mismatch = await request(101);
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.headers.get('idempotency-status'), 'mismatch');
    await mismatch.text();
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
  console.log(
    `PASS ${name}: NestFactory create/init/listen, HTTP first request/replay/mismatch, close`,
  );
}
