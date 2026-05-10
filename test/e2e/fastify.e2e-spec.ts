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
import type { FastifyReply } from 'fastify';
import request from 'supertest';

import { Idempotent } from '../../src/idempotency.decorator';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IdempotencyModule } from '../../src/idempotency.module';
import { MemoryStorage } from '../../src/storage/memory.storage';

const calls = { create: 0, capture: 0, headers: 0 };

@Controller('fastify-payments')
class FastifyPaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: { amount: number }) {
    calls.create += 1;
    return { id: `fp_${calls.create}`, amount: dto.amount };
  }

  @Post('headers')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  withHeaders(
    @Body() dto: { amount: number },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    calls.headers += 1;
    reply.header('Location', `/fastify-payments/fp_header_${calls.headers}`);
    reply.header('X-Request-Id', `fastify_req_${calls.headers}`);
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
      storage: new MemoryStorage(),
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

  beforeEach(() => {
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

    const second = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-replay')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(calls.create).toBe(1);
  });

  it('returns 400 when the required key is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/fastify-payments')
      .send({ amount: 50 });

    expect(res.status).toBe(400);
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 100 });

    const conflicting = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 999 });

    expect(conflicting.status).toBe(422);
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

    const second = await request(app.getHttpServer())
      .post('/fastify-payments/headers')
      .set('Idempotency-Key', 'fastify-headers')
      .send({ amount: 250 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe('/fastify-payments/fp_header_1');
    expect(second.headers['x-request-id']).toBe('fastify_req_1');
    expect(calls.headers).toBe(1);
  });
});
