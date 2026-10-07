import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Injectable,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createHmac, timingSafeEqual } from 'crypto';
import request from 'supertest';

import { Idempotent } from '../../src/idempotency.decorator';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IdempotencyModule } from '../../src/idempotency.module';
import { MemoryStorage } from '../../src/storage/memory.storage';

interface Identity {
  tenantId: string;
  id: string;
}

interface FixtureRequest {
  headers: Record<string, string | string[] | undefined>;
  user: Identity;
  rawBody?: Buffer;
  rawHeaders?: string[];
  raw?: { rawHeaders: string[] };
  body: { id: string };
}

const accounts: Record<string, Identity> = {
  alice: { tenantId: 'tenant-a', id: 'alice' },
  bob: { tenantId: 'tenant-a', id: 'bob' },
  otherTenant: { tenantId: 'tenant-b', id: 'alice' },
};
const webhookSecret = 'request-isolation-fixture-secret';

function signature(body: string): string {
  return createHmac('sha256', webhookSecret).update(body).digest('hex');
}

@Injectable()
class FixtureState {
  handlerCalls = 0;
  authChecks = 0;
  signatureChecks = 0;
  revoked = new Set<string>();
  rawHeaders: string[] = [];
}

/** Guards authenticate every request before the interceptor can read storage. */
@Injectable()
class AccountGuard implements CanActivate {
  constructor(private readonly state: FixtureState) {}

  canActivate(context: ExecutionContext): boolean {
    this.state.authChecks += 1;
    const req = context.switchToHttp().getRequest<FixtureRequest>();
    this.state.rawHeaders = req.rawHeaders ?? req.raw?.rawHeaders ?? [];
    const authorization = req.headers.authorization;
    const credential =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
    const account = accounts[credential];
    if (!account) throw new UnauthorizedException();
    if (this.state.revoked.has(credential)) throw new ForbiddenException();

    // Tenant/user headers do not supply identity; the validated account does.
    req.user = account;
    return true;
  }
}

@Injectable()
class SignatureGuard implements CanActivate {
  constructor(private readonly state: FixtureState) {}

  canActivate(context: ExecutionContext): boolean {
    this.state.signatureChecks += 1;
    const req = context.switchToHttp().getRequest<FixtureRequest>();
    const supplied = req.headers['x-signature'];
    if (!req.rawBody || typeof supplied !== 'string') {
      throw new UnauthorizedException();
    }
    const expected = createHmac('sha256', webhookSecret).update(req.rawBody).digest();
    const actual = Buffer.from(supplied, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException();
    }
    req.user = { tenantId: 'trusted-provider', id: 'webhook' };
    return true;
  }
}

@Controller()
@UseGuards(AccountGuard)
@UseInterceptors(IdempotencyInterceptor)
class AccountController {
  constructor(private readonly state: FixtureState) {}

  @Post('payments/:id/capture')
  @Idempotent()
  capture(@Req() req: FixtureRequest, @Param('id') id: string, @Body() body: { amount: number }) {
    return {
      operation: 'capture',
      resource: id,
      ...req.user,
      ...body,
      sequence: ++this.state.handlerCalls,
    };
  }

  @Post('refunds/:id/capture')
  @Idempotent()
  refund(@Req() req: FixtureRequest, @Param('id') id: string) {
    return {
      operation: 'refund',
      resource: id,
      ...req.user,
      sequence: ++this.state.handlerCalls,
    };
  }

  @Post('optional')
  @Idempotent({ required: false })
  optional() {
    return { sequence: ++this.state.handlerCalls };
  }
}

@Controller('webhooks')
@UseGuards(SignatureGuard)
@UseInterceptors(IdempotencyInterceptor)
class WebhookController {
  constructor(private readonly state: FixtureState) {}

  @Post()
  @Idempotent({
    keyResolver: (context) => {
      const req = context.switchToHttp().getRequest<FixtureRequest>();
      return req.body.id;
    },
  })
  receive(@Body() body: { id: string }) {
    return { eventId: body.id, sequence: ++this.state.handlerCalls };
  }
}

describe.each(['Express', 'Fastify'] as const)(
  '%s authenticated request isolation (e2e)',
  (adapter) => {
    let app: INestApplication;
    let storage: MemoryStorage;
    let state: FixtureState;
    let storageCalls: jest.SpyInstance[];

    beforeAll(async () => {
      storage = new MemoryStorage();
      const moduleRef = await Test.createTestingModule({
        imports: [
          IdempotencyModule.forRoot({
            storage,
            scope: (context) => {
              const { user } = context.switchToHttp().getRequest<FixtureRequest>();
              return [user.tenantId, user.id];
            },
          }),
        ],
        controllers: [AccountController, WebhookController],
        providers: [FixtureState, AccountGuard, SignatureGuard],
      }).compile();
      state = moduleRef.get(FixtureState);
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
      state.handlerCalls = 0;
      state.authChecks = 0;
      state.signatureChecks = 0;
      state.revoked.clear();
      state.rawHeaders = [];
      storageCalls = [
        jest.spyOn(storage, 'get'),
        jest.spyOn(storage, 'create'),
        jest.spyOn(storage, 'complete'),
        jest.spyOn(storage, 'delete'),
      ];
    });

    afterAll(async () => {
      await app?.close();
      await storage?.onModuleDestroy();
    });

    function capture(
      credential = 'alice',
      path = '/payments/pay-1/capture',
      key = 'shared-key',
      amount = 100,
    ) {
      return request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${credential}`)
        .set('Idempotency-Key', key)
        .send({ amount });
    }

    function expectStorageUntouched() {
      for (const call of storageCalls) expect(call).not.toHaveBeenCalled();
    }

    it.each([
      ['user', 'bob', '/payments/pay-1/capture', 'shared-key'],
      ['tenant', 'otherTenant', '/payments/pay-1/capture', 'shared-key'],
      ['endpoint', 'alice', '/refunds/pay-1/capture', 'shared-key'],
      ['resource', 'alice', '/payments/pay-2/capture', 'shared-key'],
      ['key', 'alice', '/payments/pay-1/capture', 'different-key'],
    ])(
      'isolates a different %s and replays each authenticated operation',
      async (_dimension, credential, path, key) => {
        const first = await capture();
        const other = await capture(credential, path, key);
        expect(first.status).toBe(201);
        expect(other.status).toBe(201);
        expect(first.body.sequence).toBe(1);
        expect(other.body.sequence).toBe(2);
        expect(other.body).toMatchObject(accounts[credential]);

        const firstRetry = await capture();
        const otherRetry = await capture(credential, path, key);
        expect(firstRetry.status).toBe(201);
        expect(otherRetry.status).toBe(201);
        expect(firstRetry.body).toEqual(first.body);
        expect(otherRetry.body).toEqual(other.body);
        expect(state.handlerCalls).toBe(2);
        expect(state.authChecks).toBe(4);
      },
    );

    it('takes identity from authentication even when identity headers are forged', async () => {
      const alice = await capture();
      const bob = await capture('bob')
        .set('X-Tenant-Id', accounts.alice.tenantId)
        .set('X-User-Id', accounts.alice.id);

      expect(bob.status).toBe(201);
      expect(bob.body).toMatchObject(accounts.bob);
      expect(bob.body.sequence).not.toBe(alice.body.sequence);
      expect(state.handlerCalls).toBe(2);
    });

    it('checks authentication and current authorization before a cached replay', async () => {
      const first = await capture();
      expect(first.status).toBe(201);
      for (const call of storageCalls) call.mockClear();

      expect((await capture('invalid')).status).toBe(401);
      expectStorageUntouched();
      state.revoked.add('alice');
      expect((await capture()).status).toBe(403);
      expectStorageUntouched();
      expect(state.handlerCalls).toBe(1);

      state.revoked.delete('alice');
      const retry = await capture();
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
      expect(state.authChecks).toBe(4);
    });

    it('returns 422 for a changed body only within the same authenticated scope', async () => {
      expect((await capture()).status).toBe(201);
      const mismatch = await capture('alice', undefined, undefined, 999);
      expect(mismatch.status).toBe(422);
      expect(state.handlerCalls).toBe(1);

      const differentUser = await capture('bob', undefined, undefined, 999);
      expect(differentUser.status).toBe(201);
      expect(differentUser.body).toMatchObject({ ...accounts.bob, amount: 999 });
      expect(state.handlerCalls).toBe(2);
    });

    it('preserves the contract that query strings do not create a new scope', async () => {
      const first = await capture('alice', '/payments/pay-1/capture?view=one');
      const retry = await capture('alice', '/payments/pay-1/capture?view=two');
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
      ['joined', 'first,second'],
      ['control', 'first\tsecond'],
      ['too many UTF-8 bytes', 'é'.repeat(86)],
    ])('rejects a %s header before storage even when optional', async (_label, key) => {
      const result = await capture('alice', '/optional', key);
      expect(result.status).toBe(400);
      expect(state.handlerCalls).toBe(0);
      expectStorageUntouched();
    });

    it('rejects repeated physical header fields before storage', async () => {
      const result = await request(app.getHttpServer())
        .post('/optional')
        .set('Authorization', 'Bearer alice')
        .set({ 'Idempotency-Key': ['same', 'same'] })
        .send({ amount: 100 });

      const receivedKeyFields = state.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key',
      );
      expect(receivedKeyFields).toHaveLength(2);
      expect(result.status).toBe(400);
      expect(state.handlerCalls).toBe(0);
      expectStorageUntouched();
    });

    it('bypasses only an absent optional header', async () => {
      for (let i = 0; i < 2; i += 1) {
        const result = await request(app.getHttpServer())
          .post('/optional')
          .set('Authorization', 'Bearer alice')
          .send({ amount: 100 });
        expect(result.status).toBe(201);
      }
      expect(state.handlerCalls).toBe(2);
      expectStorageUntouched();
    });

    it('preserves quoted and unquoted opaque key values as distinct operations', async () => {
      const unquoted = await capture('alice', undefined, 'literal-key');
      const quoted = await capture('alice', undefined, '"literal-key"');
      const quotedRetry = await capture('alice', undefined, '"literal-key"');
      expect(unquoted.status).toBe(201);
      expect(quoted.status).toBe(201);
      expect(quoted.body.sequence).not.toBe(unquoted.body.sequence);
      expect(quotedRetry.status).toBe(201);
      expect(quotedRetry.body).toEqual(quoted.body);
      expect(state.handlerCalls).toBe(2);
    });

    it('accepts a printable header at the 255-byte limit', async () => {
      const first = await capture('alice', undefined, 'a'.repeat(255));
      const retry = await capture('alice', undefined, 'a'.repeat(255));
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
    });

    function webhook(body: string, suppliedSignature = signature(body)) {
      return request(app.getHttpServer())
        .post('/webhooks')
        .set('Content-Type', 'application/json')
        .set('X-Signature', suppliedSignature)
        .send(body);
    }

    it('verifies the raw webhook signature before every replay', async () => {
      const body = JSON.stringify({ id: 'event-1', amount: 100 });
      const first = await webhook(body);
      expect(first.status).toBe(201);
      for (const call of storageCalls) call.mockClear();

      const invalid = await webhook(body, '00'.repeat(32));
      expect(invalid.status).toBe(401);
      expectStorageUntouched();
      expect(state.handlerCalls).toBe(1);

      const retry = await webhook(body);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
      expect(state.signatureChecks).toBe(3);
    });

    it('uses the verified event id resolver independently of malformed key headers', async () => {
      const body = JSON.stringify({ id: 'event,with,commas' });
      const first = await webhook(body).set({ 'Idempotency-Key': ['one', 'two'] });
      const retry = await webhook(body).set('Idempotency-Key', '');
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
      expect(state.signatureChecks).toBe(2);
    });

    it('accepts and replays a Unicode event id at the UTF-8 byte limit', async () => {
      const body = JSON.stringify({ id: '한'.repeat(85) });
      const first = await webhook(body);
      const retry = await webhook(body);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(state.handlerCalls).toBe(1);
    });

    it.each([
      { label: 'number', id: 42 },
      { label: 'null', id: null },
      { label: 'array', id: [] },
      { label: 'object', id: {} },
      { label: 'empty string', id: '' },
      { label: 'whitespace-only string', id: ' ' },
      { label: 'control character', id: 'event\n1' },
      { label: 'too many UTF-8 bytes', id: '한'.repeat(86) },
    ])('rejects signed resolver output with $label before storage or handler', async ({ id }) => {
      const result = await webhook(JSON.stringify({ id }));
      expect(result.status).toBe(400);
      expect(state.signatureChecks).toBe(1);
      expect(state.handlerCalls).toBe(0);
      expectStorageUntouched();
    });
  },
);
