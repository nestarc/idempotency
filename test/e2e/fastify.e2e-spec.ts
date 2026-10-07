import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  Module,
  Param,
  Post,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { Idempotent } from '../../src/idempotency.decorator';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IdempotencyModule } from '../../src/idempotency.module';
import { MemoryStorage } from '../../src/storage/memory.storage';

const calls = { create: 0, capture: 0, headers: 0 };
const storage = new MemoryStorage();
let inFlight: { entered: () => void; release: Promise<void> } | undefined;

@Controller('fastify-payments')
class FastifyPaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  async create(@Body() dto: { amount: number }) {
    calls.create += 1;
    if (inFlight) {
      inFlight.entered();
      await inFlight.release;
    }
    return { id: `fp_${calls.create}`, amount: dto.amount };
  }

  @Post('headers')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  withHeaders(
    @Body() dto: { amount: number },
    @Res({ passthrough: true })
    reply: { header: (name: string, value: string) => unknown },
  ) {
    calls.headers += 1;
    reply.header('Location', `/fastify-payments/fp_header_${calls.headers}`);
    reply.header('X-Request-Id', `fastify_req_${calls.headers}`);
    reply.header('Set-Cookie', 'session=first-response-only; HttpOnly');
    reply.header('Private-Trace', 'first-response-only');
    return { id: `fp_header_${calls.headers}`, amount: dto.amount };
  }

  @Post(':id/capture')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  capture(@Param('id') _id: string, @Body() dto: { amount: number }) {
    calls.capture += 1;
    return { id: `fc_${calls.capture}`, amount: dto.amount };
  }
}

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage,
      scope: 'endpoint',
    }),
  ],
  controllers: [FastifyPaymentsController],
})
class FastifyTestAppModule {}

describe('Idempotency Fastify adapter (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FastifyTestAppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await storage.onModuleDestroy();
    calls.create = 0;
    calls.capture = 0;
    calls.headers = 0;
  });

  it('replays duplicate requests without re-running the handler', async () => {
    const first = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-replay')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'fp_1', amount: 100 });
    expect(first.headers['idempotency-status']).toBe('created');

    const second = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-replay')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-status']).toBe('replayed');
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(calls.create).toBe(1);
  });

  it('returns 400 when the required key is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/fastify-payments')
      .send({ amount: 50 });

    expect(res.status).toBe(400);
    expect(calls.create).toBe(0);
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    const original = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 100 });

    const conflicting = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 999 });

    expect(conflicting.status).toBe(422);
    expect(conflicting.headers['idempotency-status']).toBe('mismatch');
    const replay = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 100 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(original.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(calls.create).toBe(1);
  });

  it('rejects an in-flight duplicate and replays only after completion', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    inFlight = {
      entered,
      release: new Promise<void>((resolve) => { release = resolve; }),
    };
    const send = () => request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-concurrent')
      .send({ amount: 777 })
      .timeout({ deadline: 3000 });
    const firstRequest = send().then((response) => response);
    try {
      await Promise.race([
        waiting,
        firstRequest.then(() => { throw new Error('Handler did not wait at the concurrency gate'); }),
      ]);
      const collision = await send();
      expect(collision.status).toBe(409);
      expect(collision.headers['idempotency-status']).toBe('conflict');
      expect(calls.create).toBe(1);
    } finally {
      release();
      inFlight = undefined;
      await firstRequest;
    }
    const first = await firstRequest;
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'fp_1', amount: 777 });
    expect(first.headers['idempotency-status']).toBe('created');
    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(calls.create).toBe(1);
  });

  it('does not conflate parameterized route targets with the same key and body', async () => {
    const first = await request(app.getHttpServer())
      .post('/fastify-payments/pay_1/capture')
      .set('Idempotency-Key', 'fastify-capture')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'fc_1', amount: 100 });

    const second = await request(app.getHttpServer())
      .post('/fastify-payments/pay_2/capture')
      .set('Idempotency-Key', 'fastify-capture')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual({ id: 'fc_2', amount: 100 });
    expect(calls.capture).toBe(2);
  });

  it('replays allowed headers under Fastify without re-running the handler', async () => {
    const first = await request(app.getHttpServer())
      .post('/fastify-payments/headers')
      .set('Idempotency-Key', 'fastify-headers')
      .send({ amount: 250 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'fp_header_1', amount: 250 });
    expect(first.headers.location).toBe('/fastify-payments/fp_header_1');
    expect(first.headers['x-request-id']).toBe('fastify_req_1');
    expect(first.headers['set-cookie']).toEqual(['session=first-response-only; HttpOnly']);
    expect(first.headers['private-trace']).toBe('first-response-only');

    const second = await request(app.getHttpServer())
      .post('/fastify-payments/headers')
      .set('Idempotency-Key', 'fastify-headers')
      .send({ amount: 250 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe('/fastify-payments/fp_header_1');
    expect(second.headers['x-request-id']).toBe('fastify_req_1');
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(second.headers['private-trace']).toBeUndefined();
    expect(calls.headers).toBe(1);
  });
});
