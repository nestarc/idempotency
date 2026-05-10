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
const callCounter = { create: 0, refund: 0, fail: 0, cross: 0, capture: 0 };

@Controller('payments')
class PaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: { amount: number }) {
    callCounter.create += 1;
    return { id: `pay_${callCounter.create}`, kind: 'payment', amount: dto.amount };
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
      storage: new MemoryStorage(),
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

  beforeEach(() => {
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

  // Concurrency regression: two identical requests fired simultaneously
  // must result in exactly ONE handler invocation. The loser must either
  // replay the winner's response (COMPLETED race) or receive 409 (if it
  // observes the winner still in-flight). No duplicate execution allowed.
  it('handles two truly-concurrent identical requests with exactly one handler call', async () => {
    const server = app.getHttpServer();

    // Use Promise.all to fire both requests before either has a chance
    // to finish. Both use the same Idempotency-Key and the same body.
    const [a, b] = await Promise.all([
      request(server)
        .post('/payments')
        .set('Idempotency-Key', 'concurrent-key')
        .send({ amount: 777 }),
      request(server)
        .post('/payments')
        .set('Idempotency-Key', 'concurrent-key')
        .send({ amount: 777 }),
    ]);

    // Exactly one handler invocation.
    expect(callCounter.create).toBe(1);

    // Acceptable outcomes per IETF draft:
    //   - Both 201 with identical body (replay path)
    //   - One 201, one 409 (in-flight collision path)
    // Both paths satisfy at-most-once, the only invariant that matters.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBeLessThanOrEqual(statuses[1]);

    const winners = [a, b].filter((r) => r.status === 201);
    expect(winners.length).toBeGreaterThanOrEqual(1);

    if (winners.length === 2) {
      // Both succeeded — responses must be identical (one is a replay).
      expect(winners[0].body).toEqual(winners[1].body);
    } else {
      // One 201, one other (409 expected for in-flight collision).
      const others = [a, b].filter((r) => r.status !== 201);
      expect(others).toHaveLength(1);
      expect(others[0].status).toBe(409);
    }
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
