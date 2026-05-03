import 'reflect-metadata';
import { INestApplication, Module, Controller, Post, Body } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';

import {
  IdempotencyInterceptor,
  IdempotencyModule,
  Idempotent,
  PostgresStorage,
} from '../../src';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

@Controller('payments')
class PaymentsController {
  static calls = 0;

  @Post()
  @Idempotent()
  charge(@Body() body: { amount: number }): { id: string; amount: number } {
    PaymentsController.calls += 1;
    return { id: `txn-${PaymentsController.calls}`, amount: body.amount };
  }
}

describeOrSkip('PostgresStorage e2e', () => {
  let app: INestApplication;
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
    PaymentsController.calls = 0;

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({ pool }),
        }),
      ],
      controllers: [PaymentsController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('replays the cached response on repeat with the same key + body', async () => {
    const r1 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k1')
      .send({ amount: 100 });
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({ id: 'txn-1', amount: 100 });

    const r2 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k1')
      .send({ amount: 100 });
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual({ id: 'txn-1', amount: 100 });

    expect(PaymentsController.calls).toBe(1);
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k2')
      .send({ amount: 100 })
      .expect(201);

    const r2 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k2')
      .send({ amount: 999 });
    expect(r2.status).toBe(422);
  });

  it('two concurrent requests result in exactly one handler execution', async () => {
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'k3')
        .send({ amount: 100 }),
      request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'k3')
        .send({ amount: 100 }),
    ]);

    expect(PaymentsController.calls).toBe(1);
    const statuses = [r1.status, r2.status].sort();
    // Either both replayed, or one 201 + one 409.
    expect(
      JSON.stringify(statuses) === '[201,201]' ||
        JSON.stringify(statuses) === '[201,409]',
    ).toBe(true);
  });
});
