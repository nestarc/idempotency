import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Module,
  Post,
  UseInterceptors,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { IdempotencyModule } from '../../src/idempotency.module';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { Idempotent } from '../../src/idempotency.decorator';
import { MemoryStorage } from '../../src/storage/memory.storage';

/** Counter that lets us verify the handler ran exactly once across replays. */
const callCounter = { create: 0, refund: 0, fail: 0 };

@Controller('payments')
class PaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: { amount: number }) {
    callCounter.create += 1;
    return { id: `pay_${callCounter.create}`, amount: dto.amount };
  }

  @Post('refund')
  @HttpCode(202)
  @Idempotent({ ttl: 300 })
  @UseInterceptors(IdempotencyInterceptor)
  refund(@Body() dto: { id: string }) {
    callCounter.refund += 1;
    return { refundId: `rfd_${callCounter.refund}`, paymentId: dto.id };
  }

  @Post('failing')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  failing(@Body() _dto: unknown) {
    callCounter.fail += 1;
    if (callCounter.fail < 2) {
      throw new HttpException('intentional failure', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return { ok: true, attempt: callCounter.fail };
  }
}

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage: new MemoryStorage(),
    }),
  ],
  controllers: [PaymentsController],
})
class TestAppModule {}

describe('Idempotency (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    callCounter.create = 0;
    callCounter.refund = 0;
    callCounter.fail = 0;
  });

  it('processes a first request normally and returns 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'test-1')
      .send({ amount: 100 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'pay_1', amount: 100 });
    expect(callCounter.create).toBe(1);
  });

  it('replays the cached response on a duplicate request without re-running the handler', async () => {
    const first = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'replay-key')
      .send({ amount: 250 });

    expect(first.status).toBe(201);
    const firstId = first.body.id;

    const second = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'replay-key')
      .send({ amount: 250 });

    expect(second.status).toBe(201);
    expect(second.body.id).toBe(firstId);
    expect(callCounter.create).toBe(1); // handler ran exactly once
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ amount: 100 });

    const conflicting = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ amount: 999 });

    expect(conflicting.status).toBe(422);
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/payments')
      .send({ amount: 50 });

    expect(res.status).toBe(400);
  });

  it('deletes the key when the handler throws so the next attempt can succeed', async () => {
    const failing = await request(app.getHttpServer())
      .post('/payments/failing')
      .set('Idempotency-Key', 'retry-key')
      .send({ payload: 1 });

    expect(failing.status).toBe(500);

    const retry = await request(app.getHttpServer())
      .post('/payments/failing')
      .set('Idempotency-Key', 'retry-key')
      .send({ payload: 1 });

    expect(retry.status).toBe(201); // Default 201 since no @HttpCode set
    expect(retry.body).toEqual({ ok: true, attempt: 2 });
    expect(callCounter.fail).toBe(2); // The handler ran twice
  });

  it('respects per-handler TTL override (refund uses ttl=300)', async () => {
    // We can't time-travel through Express in a real-server test, but we can
    // at least verify the route works and replays correctly with the override.
    const first = await request(app.getHttpServer())
      .post('/payments/refund')
      .set('Idempotency-Key', 'refund-key')
      .send({ id: 'pay_x' });

    expect(first.status).toBe(202);

    const second = await request(app.getHttpServer())
      .post('/payments/refund')
      .set('Idempotency-Key', 'refund-key')
      .send({ id: 'pay_x' });

    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(callCounter.refund).toBe(1);
  });
});
