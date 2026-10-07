import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Exclude } from 'class-transformer';
import { createHmac, timingSafeEqual } from 'crypto';
import { Pool } from 'pg';
import request from 'supertest';

// This suite tests HTTP/business integration against source. Packed public imports
// are tested separately by test/consumers; docs use @nestarc/idempotency.
import { Idempotent, IdempotencyInterceptor, IdempotencyModule, MemoryStorage } from '../../src';
import {
  RecipeLedger,
  type OrderCommand,
  type PaymentCommand,
  type PaymentResult,
  type RecipeEvent,
  type RecipeIdentity,
} from '../support/adoption-business';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.S7_REQUIRE_REAL_STORAGE === '1' && !databaseUrl) {
  throw new Error('S7 adoption recipes require TEST_DATABASE_URL');
}
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ledgerToken = Symbol('RECIPE_LEDGER');
const signatureSecret = 'local-simulator-secret-not-for-production';
const accounts: Record<string, RecipeIdentity> = {
  alice: { tenantId: 'tenant-a', userId: 'alice' },
  bob: { tenantId: 'tenant-a', userId: 'bob' },
  otherTenant: { tenantId: 'tenant-b', userId: 'alice' },
};

interface RecipeRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  user: RecipeIdentity;
  verifiedEvent: RecipeEvent;
}

@Injectable()
class RecipeState {
  handlerCalls = 0;
  signatureChecks = 0;
  failAfterLedgerCommit = false;
}

@Injectable()
class RecipeAccountGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RecipeRequest>();
    const credential = req.headers.authorization;
    const account =
      typeof credential === 'string' && credential.startsWith('Bearer ')
        ? accounts[credential.slice('Bearer '.length)]
        : null;
    if (!account) throw new UnauthorizedException();
    req.user = account; // A real application's authentication/authorization guard supplies this.
    return true;
  }
}

function signature(raw: Buffer | string, timestamp: string): string {
  return createHmac('sha256', signatureSecret).update(`${timestamp}.`).update(raw).digest('hex');
}

/** Simulator protocol. Use the provider SDK, not this guard, for Stripe. */
@Injectable()
class RecipeSignatureGuard implements CanActivate {
  constructor(private readonly state: RecipeState) {}

  canActivate(context: ExecutionContext): boolean {
    this.state.signatureChecks += 1;
    const req = context.switchToHttp().getRequest<RecipeRequest>();
    const supplied = req.headers['x-recipe-signature'];
    const timestamp = req.headers['x-recipe-timestamp'];
    if (
      !req.rawBody ||
      typeof supplied !== 'string' ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      typeof timestamp !== 'string' ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    ) {
      throw new UnauthorizedException();
    }
    const expected = Buffer.from(signature(req.rawBody, timestamp), 'hex');
    if (!timingSafeEqual(Buffer.from(supplied, 'hex'), expected)) throw new UnauthorizedException();
    const event = JSON.parse(req.rawBody.toString('utf8')) as RecipeEvent | null;
    if (
      typeof event !== 'object' ||
      event === null ||
      Array.isArray(event) ||
      typeof event.id !== 'string' ||
      !event.id ||
      typeof event.objectId !== 'string' ||
      !event.objectId ||
      event.type !== 'order.changed' ||
      !Number.isSafeInteger(event.version) ||
      event.version < 1 ||
      !['pending', 'paid'].includes(event.state)
    ) {
      throw new BadRequestException();
    }
    // Binding is from the configured verified endpoint, never an unsigned tenant header.
    req.user = { tenantId: 'provider-account-a', userId: 'webhook' };
    req.verifiedEvent = event;
    return true;
  }
}

class PaymentReceipt {
  @Exclude()
  internalAuditNote = 'must never enter the replay response';

  constructor(result: PaymentResult) {
    Object.assign(this, result);
  }
}

@Controller()
@UseGuards(RecipeAccountGuard)
@UseInterceptors(IdempotencyInterceptor, ClassSerializerInterceptor)
class RecipeCommandController {
  constructor(
    @Inject(ledgerToken) private readonly ledger: RecipeLedger,
    private readonly state: RecipeState,
  ) {}

  @Post('payments')
  @Idempotent()
  async pay(@Req() req: RecipeRequest, @Body() command: PaymentCommand) {
    if (
      typeof command !== 'object' ||
      command === null ||
      Array.isArray(command) ||
      typeof command.commandId !== 'string' ||
      command.commandId.trim().length === 0 ||
      !Number.isSafeInteger(command.amount) ||
      command.amount < 1 ||
      typeof command.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(command.currency)
    )
      throw new BadRequestException();
    this.state.handlerCalls += 1;
    let result: PaymentResult;
    try {
      result = await this.ledger.pay(req.user, command);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('simulated ')) {
        throw new ServiceUnavailableException('Payment outcome needs reconciliation');
      }
      throw error;
    }
    if (this.state.failAfterLedgerCommit) {
      this.state.failAfterLedgerCommit = false;
      throw new ServiceUnavailableException('Simulated error after business commit');
    }
    return new PaymentReceipt(result);
  }

  @Post('orders')
  @Idempotent()
  order(@Req() req: RecipeRequest, @Body() command: OrderCommand) {
    if (
      typeof command !== 'object' ||
      command === null ||
      Array.isArray(command) ||
      typeof command.commandId !== 'string' ||
      command.commandId.trim().length === 0 ||
      typeof command.orderId !== 'string' ||
      command.orderId.trim().length === 0 ||
      typeof command.sku !== 'string' ||
      command.sku.trim().length === 0 ||
      !Number.isSafeInteger(command.quantity) ||
      command.quantity < 1
    )
      throw new BadRequestException();
    this.state.handlerCalls += 1;
    return this.ledger.order(req.user, command);
  }
}

@Controller('webhooks')
@UseGuards(RecipeSignatureGuard)
@UseInterceptors(IdempotencyInterceptor)
class RecipeWebhookController {
  constructor(
    @Inject(ledgerToken) private readonly ledger: RecipeLedger,
    private readonly state: RecipeState,
  ) {}

  @Post()
  @HttpCode(200)
  @Idempotent({
    ttl: 86_400,
    keyResolver: (context) => context.switchToHttp().getRequest<RecipeRequest>().verifiedEvent.id,
  })
  receive(@Req() req: RecipeRequest) {
    this.state.handlerCalls += 1;
    return this.ledger.receive(req.user.tenantId, req.verifiedEvent);
  }
}

describeWithDatabase.each(['Express', 'Fastify'] as const)(
  '%s S7 adoption recipes with real PostgreSQL and a local provider simulator',
  (adapter) => {
    let app: INestApplication;
    let storage: MemoryStorage;
    let ledger: RecipeLedger;
    let pool: Pool;
    let state: RecipeState;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
      ledger = new RecipeLedger(pool);
      await ledger.init();
      storage = new MemoryStorage();
      const moduleRef = await Test.createTestingModule({
        imports: [
          IdempotencyModule.forRoot({
            storage,
            ttl: 86_400,
            processingTtl: 60,
            scope: (context) => {
              const { user } = context.switchToHttp().getRequest<RecipeRequest>();
              return [user.tenantId, user.userId];
            },
          }),
        ],
        controllers: [RecipeCommandController, RecipeWebhookController],
        providers: [
          RecipeState,
          RecipeAccountGuard,
          RecipeSignatureGuard,
          { provide: ledgerToken, useValue: ledger },
        ],
      }).compile();
      state = moduleRef.get(RecipeState);
      if (adapter === 'Fastify') {
        const fastifyApp = moduleRef.createNestApplication<NestFastifyApplication>(
          new FastifyAdapter(),
          { rawBody: true },
        );
        await fastifyApp.init();
        await fastifyApp.getHttpAdapter().getInstance().ready();
        app = fastifyApp;
      } else {
        app = moduleRef.createNestApplication({ rawBody: true });
        await app.init();
      }
    });

    beforeEach(async () => {
      await storage.onModuleDestroy();
      await ledger.reset();
      state.handlerCalls = 0;
      state.signatureChecks = 0;
      state.failAfterLedgerCommit = false;
    });

    afterAll(async () => {
      await app?.close();
      await storage?.onModuleDestroy();
      try {
        await ledger?.dispose();
      } finally {
        await pool?.end(); // The application owns this external pool.
      }
    });

    function pay(commandId = 'pay-1', amount = 100, credential = 'alice', key = commandId) {
      return request(app.getHttpServer())
        .post('/payments')
        .set('Authorization', `Bearer ${credential}`)
        .set('Idempotency-Key', key)
        .send({ commandId, amount, currency: 'USD' });
    }

    function order(commandId = 'order-command-1', quantity = 1, key = commandId) {
      return request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', 'Bearer alice')
        .set('Idempotency-Key', key)
        .send({ commandId, orderId: 'order-1', sku: 'book', quantity });
    }

    it('rejects malformed command bodies and fields before provider or ledger effects', async () => {
      const payment = { commandId: 'pay-1', amount: 100, currency: 'USD' };
      const placedOrder = {
        commandId: 'order-command-1',
        orderId: 'order-1',
        sku: 'book',
        quantity: 1,
      };
      const cases: Array<{ path: string; body: unknown }> = [];
      for (const path of ['/payments', '/orders']) {
        for (const body of [null, [], 42, 'not-an-object']) cases.push({ path, body });
      }
      for (const value of [null, 123, {}, ['id'], '', '   ']) {
        cases.push({ path: '/payments', body: { ...payment, commandId: value } });
        for (const field of ['commandId', 'orderId', 'sku']) {
          cases.push({ path: '/orders', body: { ...placedOrder, [field]: value } });
        }
      }
      for (const currency of [null, 123, {}, ['USD'], '', '   ']) {
        cases.push({ path: '/payments', body: { ...payment, currency } });
      }
      for (const [index, { path, body }] of cases.entries()) {
        const result = await request(app.getHttpServer())
          .post(path)
          .set('Authorization', 'Bearer alice')
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', `invalid-command-${index}`)
          .send(JSON.stringify(body));
        expect(result.status).toBe(400);
      }
      expect(state.handlerCalls).toBe(0);
      expect(ledger.provider.calls).toBe(0);
      expect((await pool.query(`SELECT * FROM ${ledger.schema}.commands`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${ledger.schema}.orders`)).rowCount).toBe(0);
    });

    it('replays a serialized payment receipt without calling the provider twice', async () => {
      const first = await pay();
      const retry = await pay();
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(first.body).not.toHaveProperty('internalAuditNote');
      expect(first.headers['idempotency-status']).toBe('created');
      expect(retry.headers['idempotency-status']).toBe('replayed');
      expect(ledger.provider.calls).toBe(1);
      expect(state.handlerCalls).toBe(1);
    });

    it('rejects changed intent before replay and after a caller changes only the HTTP key', async () => {
      expect((await pay()).status).toBe(201);
      expect((await pay('pay-1', 999)).status).toBe(422);
      expect((await pay('pay-1', 999, 'alice', 'different-http-key')).status).toBe(422);
      expect(ledger.provider.calls).toBe(1);
    });

    it('isolates tenant/user/endpoint and enforces ownership again on a cache miss', async () => {
      const alice = await pay('pay-1', 100, 'alice', 'shared-key');
      const bob = await pay('pay-2', 200, 'bob', 'shared-key');
      const tenant = await pay('pay-1', 300, 'otherTenant', 'shared-key');
      const placedOrder = await order('order-command-1', 1, 'shared-key');
      expect([alice.status, bob.status, tenant.status, placedOrder.status]).toEqual([
        201, 201, 201, 201,
      ]);
      expect(bob.body.amount).toBe(200);
      expect(tenant.body.amount).toBe(300);
      expect(placedOrder.body).toEqual({ orderId: 'order-1' });
      expect((await pay('pay-1', 100, 'bob', 'uncached')).status).toBe(403);
      expect(ledger.provider.calls).toBe(3);
    });

    it('keeps a durable payment result after handler failure and replay-cache loss', async () => {
      state.failAfterLedgerCommit = true;
      expect((await pay()).status).toBe(503);
      const retry = await pay();
      expect(retry.status).toBe(201);
      // Model loss of this memory cache on an app restart, never an operator unlock.
      await storage.onModuleDestroy();
      const afterRestart = await pay();
      expect(afterRestart.status).toBe(201);
      expect(afterRestart.body).toEqual(retry.body);
      expect(ledger.provider.calls).toBe(1);
      expect(state.handlerCalls).toBe(3);
    });

    it('reconciles provider commit with lost acknowledgment without sending another charge', async () => {
      ledger.provider.loseAcknowledgment = true;
      expect((await pay()).status).toBe(503);
      expect((await pay()).status).toBe(409);
      const canonical = await ledger.reconcile(accounts.alice, 'pay-1');
      expect(canonical).toMatchObject({ commandId: 'pay-1', amount: 100 });
      const retry = await pay();
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(canonical);
      expect(ledger.provider.calls).toBe(1);
    });

    it('holds an unknown command even when the provider lookup returns no record', async () => {
      ledger.provider.unavailable = true;
      expect((await pay()).status).toBe(503);
      ledger.provider.unavailable = false;
      expect(await ledger.reconcile(accounts.alice, 'pay-1')).toBeNull();
      await storage.onModuleDestroy();
      expect((await pay()).status).toBe(409);
      expect(ledger.provider.calls).toBe(1);
    });

    it('atomically deduplicates orders by command and business identity after cache loss', async () => {
      expect((await order()).status).toBe(201);
      await storage.onModuleDestroy();
      expect((await order()).status).toBe(201);
      expect((await order('another-command')).status).toBe(201);
      expect((await order('changed-intent', 2)).status).toBe(422);
      const rows = await pool.query(`SELECT * FROM ${ledger.schema}.orders`);
      expect(rows.rowCount).toBe(1);
    });

    function event(overrides: Partial<RecipeEvent> = {}): RecipeEvent {
      return {
        id: 'evt-1',
        objectId: 'provider-order-1',
        type: 'order.changed',
        version: 2,
        state: 'paid',
        ...overrides,
      };
    }

    function webhook(
      value: RecipeEvent,
      valid = true,
      timestamp = String(Math.floor(Date.now() / 1000)),
    ) {
      const raw = JSON.stringify(value);
      return request(app.getHttpServer())
        .post('/webhooks')
        .set('Content-Type', 'application/json')
        .set('X-Recipe-Timestamp', timestamp)
        .set('X-Recipe-Signature', valid ? signature(raw, timestamp) : '00'.repeat(32))
        .send(raw);
    }

    it('verifies signature and timestamp before consulting an existing replay record', async () => {
      const first = await webhook(event());
      expect(first.status).toBe(200);
      const lookup = jest.spyOn(storage, 'get');
      expect((await webhook(event(), false)).status).toBe(401);
      expect((await webhook(event(), true, '1')).status).toBe(401);
      expect(lookup).not.toHaveBeenCalled();
      const retry = await webhook(event());
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
      expect(state.signatureChecks).toBe(4);
    });

    it('separates event delivery deduplication, business uniqueness, and event order', async () => {
      expect((await webhook(event())).status).toBe(200);
      await storage.onModuleDestroy();
      expect((await webhook(event())).status).toBe(200); // Durable event-ID dedup.
      expect((await webhook(event({ id: 'evt-2', version: 3 }))).status).toBe(200); // Same business effect.
      expect((await webhook(event({ id: 'evt-old', version: 1, state: 'pending' }))).status).toBe(
        200,
      );
      const inbox = await pool.query(`SELECT * FROM ${ledger.schema}.inbox`);
      const projection = await pool.query(
        `SELECT version, state FROM ${ledger.schema}.order_projection`,
      );
      const fulfillment = await pool.query(`SELECT * FROM ${ledger.schema}.fulfillments`);
      expect(inbox.rowCount).toBe(3);
      expect(projection.rows).toEqual([{ version: 3, state: 'paid' }]);
      expect(fulfillment.rowCount).toBe(1);
    });

    it('rejects changed signed content for an existing event even after replay-cache loss', async () => {
      expect((await webhook(event())).status).toBe(200);
      expect((await webhook(event({ state: 'pending' }))).status).toBe(422);
      await storage.onModuleDestroy();
      expect((await webhook(event({ state: 'pending' }))).status).toBe(422);
      const projection = await pool.query(`SELECT state FROM ${ledger.schema}.order_projection`);
      expect(projection.rows).toEqual([{ state: 'paid' }]);
    });
  },
);
