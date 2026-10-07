import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Module,
  Post,
  Res,
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
const callCounter = { create: 0, refund: 0, fail: 0, cross: 0, capture: 0 };
const storage = new MemoryStorage();
let inFlight: { entered: () => void; release: Promise<void> } | undefined;

@Controller('payments')
class PaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  async create(@Body() dto: { amount: number }) {
    callCounter.create += 1;
    if (inFlight) {
      inFlight.entered();
      await inFlight.release;
    }
    return { id: `pay_${callCounter.create}`, kind: 'payment', amount: dto.amount };
  }

  @Post('with-headers')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  withHeaders(
    @Body() dto: { amount: number },
    @Res({ passthrough: true })
    res: { setHeader(name: string, value: string): void },
  ) {
    callCounter.create += 1;
    res.setHeader('Location', `/payments/pay_header_${callCounter.create}`);
    res.setHeader('X-Request-Id', `req_header_${callCounter.create}`);
    res.setHeader('Set-Cookie', 'session=first-response-only; HttpOnly');
    res.setHeader('Private-Trace', 'first-response-only');
    return { id: `pay_header_${callCounter.create}`, amount: dto.amount };
  }

  @Post('refund')
  @HttpCode(202)
  @Idempotent({ ttl: 300 })
  @UseInterceptors(IdempotencyInterceptor)
  refund(@Body() dto: { id: string }) {
    callCounter.refund += 1;
    return { refundId: `rfd_${callCounter.refund}`, paymentId: dto.id };
  }

  @Post(':id/capture')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  capture(@Body() dto: { amount: number }) {
    callCounter.capture += 1;
    return {
      id: `cap_${callCounter.capture}`,
      kind: 'capture',
      amount: dto.amount,
    };
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

// A second, independent controller that happens to share the payments path-ish
// name but is a distinct class+method — used for P1 #2 cross-endpoint regression.
@Controller('transfers')
class TransfersController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  transfer(@Body() dto: { amount: number }) {
    callCounter.cross += 1;
    return { id: `tr_${callCounter.cross}`, kind: 'transfer', amount: dto.amount };
  }
}

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage,
      // Default scope 'endpoint' is what we want to verify — make it explicit.
      scope: 'endpoint',
    }),
  ],
  controllers: [PaymentsController, TransfersController],
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

  beforeEach(async () => {
    await storage.onModuleDestroy();
    callCounter.create = 0;
    callCounter.refund = 0;
    callCounter.fail = 0;
    callCounter.cross = 0;
    callCounter.capture = 0;
  });

  it('processes a first request normally and returns 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'test-1')
      .send({ amount: 100 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'pay_1', kind: 'payment', amount: 100 });
    expect(callCounter.create).toBe(1);
  });

  it('replays the cached response on a duplicate request without re-running the handler', async () => {
    const first = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'replay-key')
      .send({ amount: 250 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'pay_1', kind: 'payment', amount: 250 });
    expect(first.headers['idempotency-status']).toBe('created');

    const second = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'replay-key')
      .send({ amount: 250 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-status']).toBe('replayed');
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(callCounter.create).toBe(1); // handler ran exactly once
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    const original = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ amount: 100 });

    const conflicting = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ amount: 999 });

    expect(conflicting.status).toBe(422);
    expect(conflicting.headers['idempotency-status']).toBe('mismatch');
    const replay = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'mismatch-key')
      .send({ amount: 100 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(original.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(callCounter.create).toBe(1);
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/payments')
      .send({ amount: 50 });

    expect(res.status).toBe(400);
    expect(callCounter.create).toBe(0);
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
    const replay = await request(app.getHttpServer())
      .post('/payments/failing')
      .set('Idempotency-Key', 'retry-key')
      .send({ payload: 1 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(retry.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(callCounter.fail).toBe(2);
  });

  it('expires the refund override at 300 seconds while the default route still replays', async () => {
    // Advance only Date: HTTP sockets and eviction timers retain their real scheduling.
    jest.useFakeTimers({
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate',
        'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    const now = new Date('2026-01-01T00:00:00Z');
    jest.setSystemTime(now);
    try {
      const payment = await request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'default-ttl-key')
        .send({ amount: 100 });
      expect(payment.status).toBe(201);
      const first = await request(app.getHttpServer())
        .post('/payments/refund')
        .set('Idempotency-Key', 'refund-key')
        .send({ id: 'pay_x' });

      expect(first.status).toBe(202);
      expect(first.body).toEqual({ refundId: 'rfd_1', paymentId: 'pay_x' });

      jest.setSystemTime(now.getTime() + 299_999);
      const second = await request(app.getHttpServer())
        .post('/payments/refund')
        .set('Idempotency-Key', 'refund-key')
        .send({ id: 'pay_x' });

      expect(second.status).toBe(202);
      expect(second.body).toEqual(first.body);
      expect(callCounter.refund).toBe(1);
      expect(second.headers['idempotency-status']).toBe('replayed');

      jest.setSystemTime(now.getTime() + 300_000);
      const expired = await request(app.getHttpServer())
        .post('/payments/refund')
        .set('Idempotency-Key', 'refund-key')
        .send({ id: 'pay_x' });
      expect(expired.status).toBe(202);
      expect(expired.body).toEqual({ refundId: 'rfd_2', paymentId: 'pay_x' });
      expect(expired.headers['idempotency-status']).toBe('created');
      expect(callCounter.refund).toBe(2);
      const defaultReplay = await request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'default-ttl-key')
        .send({ amount: 100 });
      expect(defaultReplay.status).toBe(201);
      expect(defaultReplay.body).toEqual(payment.body);
      expect(defaultReplay.headers['idempotency-status']).toBe('replayed');
      expect(callCounter.create).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('replays safe response headers on duplicate requests', async () => {
    const first = await request(app.getHttpServer())
      .post('/payments/with-headers')
      .set('Idempotency-Key', 'header-key')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'pay_header_1', amount: 100 });
    expect(first.headers.location).toBe('/payments/pay_header_1');
    expect(first.headers['x-request-id']).toBe('req_header_1');
    expect(first.headers['set-cookie']).toEqual(['session=first-response-only; HttpOnly']);
    expect(first.headers['private-trace']).toBe('first-response-only');

    const second = await request(app.getHttpServer())
      .post('/payments/with-headers')
      .set('Idempotency-Key', 'header-key')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe('/payments/pay_header_1');
    expect(second.headers['x-request-id']).toBe('req_header_1');
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(second.headers['private-trace']).toBeUndefined();
    expect(callCounter.create).toBe(1);
  });

  // P1 #2 regression: two different endpoints using the SAME Idempotency-Key
  // value must not interfere with each other under scope='endpoint'.
  it('does not conflate endpoints: same key on /payments and /transfers runs both handlers', async () => {
    const pay = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'cross-endpoint-key')
      .send({ amount: 100 });

    expect(pay.status).toBe(201);
    expect(pay.body.kind).toBe('payment');

    // Same key, same body, different endpoint — under the fixed contract,
    // the transfer handler runs and returns its own response.
    const transfer = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', 'cross-endpoint-key')
      .send({ amount: 100 });

    expect(transfer.status).toBe(201);
    expect(transfer.body.kind).toBe('transfer');

    // Both handlers ran exactly once.
    expect(callCounter.create).toBe(1);
    expect(callCounter.cross).toBe(1);

    // Each endpoint still replays correctly WITHIN its own scope.
    const payAgain = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'cross-endpoint-key')
      .send({ amount: 100 });
    expect(payAgain.body).toEqual(pay.body);
    expect(callCounter.create).toBe(1); // still 1

    const transferAgain = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', 'cross-endpoint-key')
      .send({ amount: 100 });
    expect(transferAgain.body).toEqual(transfer.body);
    expect(callCounter.cross).toBe(1); // still 1
  });

  it('scopes endpoint keys by actual path params on capture routes', async () => {
    const first = await request(app.getHttpServer())
      .post('/payments/pay_1/capture')
      .set('Idempotency-Key', 'capture-key')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      id: 'cap_1',
      kind: 'capture',
      amount: 100,
    });

    const second = await request(app.getHttpServer())
      .post('/payments/pay_2/capture')
      .set('Idempotency-Key', 'capture-key')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual({
      id: 'cap_2',
      kind: 'capture',
      amount: 100,
    });
    expect(callCounter.capture).toBe(2);
  });

  it('rejects an in-flight duplicate, then replays the completed response without another effect', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    inFlight = {
      entered,
      release: new Promise<void>((resolve) => { release = resolve; }),
    };
    const send = () => request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'concurrent-key')
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
      expect(callCounter.create).toBe(1);
    } finally {
      release();
      inFlight = undefined;
      await firstRequest;
    }
    const first = await firstRequest;
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'pay_1', kind: 'payment', amount: 777 });
    expect(first.headers['idempotency-status']).toBe('created');
    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(callCounter.create).toBe(1);
  });

  // P1 #2 regression, negative case: different body on the OTHER endpoint
  // must NOT produce a false 422 from a neighboring endpoint's fingerprint.
  it('returns 201 (not 422) when a different endpoint reuses the key with a different body', async () => {
    await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'cross-body-key')
      .send({ amount: 100 });

    const transfer = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', 'cross-body-key')
      .send({ amount: 999 }); // different body

    // Under the fixed contract, the transfer gets its own scoped namespace
    // so the fingerprint check runs against the EMPTY slot, not against
    // the payment's fingerprint. Expect normal 201, not 422.
    expect(transfer.status).toBe(201);
    expect(transfer.body).toEqual(
      expect.objectContaining({ kind: 'transfer', amount: 999 }),
    );
  });
});
