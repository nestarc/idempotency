import 'reflect-metadata';
import { INestApplication, Module, Controller, Post, Body } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import request from 'supertest';

import { IdempotencyInterceptor, IdempotencyModule, Idempotent } from '../../src';
import { PostgresStorage } from '../../src/postgres';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.S5_REQUIRE_REAL_STORAGE === '1' && !DATABASE_URL) {
  throw new Error('Postgres HTTP integration requires TEST_DATABASE_URL');
}
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Isolate separate Jest processes too: a fixed per-spec name is not sufficient.
const TABLE_NAME = `idem_e2e_${randomUUID().replace(/-/g, '')}`;
let inFlight: { entered: () => void; release: Promise<void> } | undefined;

@Controller('payments')
class PaymentsController {
  static calls = 0;

  @Post()
  @Idempotent()
  async charge(@Body() body: { amount: number }): Promise<{ id: string; amount: number }> {
    PaymentsController.calls += 1;
    if (inFlight) {
      inFlight.entered();
      await inFlight.release;
    }
    return { id: `txn-${PaymentsController.calls}`, amount: body.amount };
  }
}

describeOrSkip('PostgresStorage e2e', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
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
    PaymentsController.calls = 0;

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({ pool, tableName: TABLE_NAME }),
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
    await app?.close();
  });

  it('replays the cached response on repeat with the same key + body', async () => {
    const r1 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k1')
      .send({ amount: 100 });
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({ id: 'txn-1', amount: 100 });
    expect(r1.headers['idempotency-status']).toBe('created');
    const persisted = await pool.query(`SELECT * FROM "${TABLE_NAME}"`);
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ status: 'COMPLETED', response_code: 201 });

    const r2 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k1')
      .send({ amount: 100 });
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual({ id: 'txn-1', amount: 100 });
    expect(r2.headers['idempotency-status']).toBe('replayed');
    expect(r2.headers['idempotency-replayed']).toBe('true');
    expect((await pool.query(`SELECT * FROM "${TABLE_NAME}"`)).rows).toEqual(persisted.rows);

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
    expect(r2.headers['idempotency-status']).toBe('mismatch');
    const replay = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k2')
      .send({ amount: 100 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ id: 'txn-1', amount: 100 });
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(PaymentsController.calls).toBe(1);
    expect((await pool.query(`SELECT * FROM "${TABLE_NAME}"`)).rowCount).toBe(1);
  });

  it('rejects an in-flight duplicate without altering its database owner, then replays', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    inFlight = {
      entered,
      release: new Promise<void>((resolve) => { release = resolve; }),
    };
    const send = () => request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k3')
      .send({ amount: 100 })
      .timeout({ deadline: 3000 });
    const firstRequest = send().then((response) => response);
    let owner: string | undefined;
    try {
      await Promise.race([
        waiting,
        firstRequest.then(() => { throw new Error('Handler did not wait at the concurrency gate'); }),
      ]);
      const before = await pool.query(`SELECT * FROM "${TABLE_NAME}"`);
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({ status: 'PROCESSING', response_code: null });
      owner = before.rows[0].token;
      const collision = await send();
      expect(collision.status).toBe(409);
      expect(collision.headers['idempotency-status']).toBe('conflict');
      expect(PaymentsController.calls).toBe(1);
      expect((await pool.query(`SELECT * FROM "${TABLE_NAME}"`)).rows).toEqual(before.rows);
    } finally {
      release();
      inFlight = undefined;
      await firstRequest;
    }
    const first = await firstRequest;
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'txn-1', amount: 100 });
    expect(first.headers['idempotency-status']).toBe('created');
    expect((await pool.query(`SELECT status, token FROM "${TABLE_NAME}"`)).rows).toEqual([
      { status: 'COMPLETED', token: owner },
    ]);
    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(PaymentsController.calls).toBe(1);
  });
});
