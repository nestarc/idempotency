import 'reflect-metadata';
import assert from 'node:assert/strict';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Injectable,
  Module,
  Post,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Exclude } from 'class-transformer';
import {
  IdempotencyInterceptor,
  IdempotencyModule,
  Idempotent,
  MemoryStorage,
  type IdempotencyOutcome,
} from '@nestarc/idempotency';
import { verifyModuleRegistrations } from './common/module-examples';
import { AppModule as QuickstartModule } from './quickstart';

type Principal = { tenantId: string; id: string };
type AuthenticatedRequest = {
  headers: { authorization?: string };
  user: Principal;
};

/** A test verifier: production applications replace this with their real authenticator. */
const verifiedSessions = new Map<string, Principal>([
  ['Bearer alice', { tenantId: 'tenant-a', id: 'alice' }],
  ['Bearer bob', { tenantId: 'tenant-a', id: 'bob' }],
  ['Bearer other-tenant', { tenantId: 'tenant-b', id: 'alice' }],
]);

@Injectable()
class AuthenticationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = verifiedSessions.get(request.headers.authorization ?? '');
    if (!principal) throw new UnauthorizedException();
    request.user = principal;
    return true;
  }
}

class PaymentResponse {
  constructor(
    readonly commandId: string,
    readonly amount: number,
  ) {}

  @Exclude()
  internalNote = 'never send or replay this field';
}

let handlerCalls = 0;

@Controller('payments')
@UseGuards(AuthenticationGuard)
@UseInterceptors(IdempotencyInterceptor, ClassSerializerInterceptor)
class PaymentsController {
  @Post()
  @Idempotent()
  create(@Body() input: { commandId: string; amount: number }): PaymentResponse {
    handlerCalls += 1;
    // A production payment also persists a tenant-scoped business command ID.
    return new PaymentResponse(input.commandId, input.amount);
  }
}

async function verifyReadmeQuickstart(): Promise<void> {
  const module = await Test.createTestingModule({ imports: [QuickstartModule] }).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    await app.listen(0, '127.0.0.1');
    for (const expected of ['created', 'replayed']) {
      const response = await fetch(`${await app.getUrl()}/payments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'demo-command-1',
        },
        body: JSON.stringify({ commandId: 'demo-command-1', amount: 100 }),
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('idempotency-status'), expected);
      assert.deepEqual(await response.json(), {
        commandId: 'demo-command-1',
        amount: 100,
        accepted: true,
      });
    }
  } finally {
    await app.close();
  }
  console.log('PASS exact README quickstart compile/init/HTTP first request/replay/close');
}

async function verifyOtherInterceptorScopes(): Promise<void> {
  for (const scope of ['global', 'method'] as const) {
    let calls = 0;
    @Controller('commands')
    class GlobalController {
      @Post()
      @Idempotent()
      create(): { accepted: boolean } {
        calls += 1;
        return { accepted: true };
      }
    }

    @Controller('commands')
    class MethodController {
      @Post()
      @UseInterceptors(IdempotencyInterceptor)
      @Idempotent()
      create(): { accepted: boolean } {
        calls += 1;
        return { accepted: true };
      }
    }

    const module = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ storage: new MemoryStorage() })],
      controllers: [scope === 'global' ? GlobalController : MethodController],
      providers:
        scope === 'global' ? [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }] : [],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.init();
      await app.listen(0, '127.0.0.1');
      for (const expected of ['created', 'replayed']) {
        const response = await fetch(`${await app.getUrl()}/commands`, {
          method: 'POST',
          headers: { 'idempotency-key': 'command-123' },
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('idempotency-status'), expected);
        assert.deepEqual(await response.json(), { accepted: true });
      }
      assert.equal(calls, 1);
    } finally {
      await app.close();
    }
    console.log(`PASS ${scope} interceptor registration compile/init/close and HTTP replay`);
  }
}

export async function runMemoryExamples(): Promise<void> {
  await verifyReadmeQuickstart();
  await verifyModuleRegistrations(new MemoryStorage());
  await verifyOtherInterceptorScopes();
  const counts = new Map<IdempotencyOutcome, number>();
  @Module({
    imports: [
      IdempotencyModule.forRoot({
        storage: new MemoryStorage(),
        ttl: 86_400,
        processingTtl: 30,
        scope: (context) => {
          const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
          return [user.tenantId, user.id];
        },
        observability: {
          onEvent: (event) => {
            // Fixed outcomes are metric labels; request-derived hashes are not.
            counts.set(event.outcome, (counts.get(event.outcome) ?? 0) + 1);
          },
        },
      }),
    ],
    controllers: [PaymentsController],
    providers: [AuthenticationGuard],
  })
  class AppModule {}

  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/payments`;
    const post = async (authorization: string, amount = 100) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'command-123',
        },
        body: JSON.stringify({ commandId: 'command-123', amount }),
      });
      return { response, body: await response.json() };
    };
    const first = await post('Bearer alice');
    assert.equal(first.response.status, 201);
    assert.equal(first.response.headers.get('idempotency-status'), 'created');
    assert.deepEqual(first.body, { commandId: 'command-123', amount: 100 });
    const replay = await post('Bearer alice');
    assert.equal(replay.response.status, 201);
    assert.equal(replay.response.headers.get('idempotency-status'), 'replayed');
    assert.deepEqual(replay.body, first.body);
    assert.equal(handlerCalls, 1);
    assert.equal((await post('Bearer alice', 101)).response.status, 422);
    assert.equal(handlerCalls, 1);
    assert.equal((await post('Bearer bob')).response.status, 201);
    assert.equal((await post('Bearer other-tenant')).response.status, 201);
    assert.equal(handlerCalls, 3, 'both tenant and user dimensions isolate responses');
    verifiedSessions.delete('Bearer alice');
    assert.equal((await post('Bearer alice')).response.status, 401);
    assert.equal(handlerCalls, 3, 'revoked authentication rejects replay before the interceptor');
    assert.equal(counts.get('created'), 3);
    assert.equal(counts.get('replayed'), 1);
    assert.equal(counts.get('mismatch'), 1);
  } finally {
    await app.close();
  }
  console.log(
    'PASS quickstart/serializer/tenant/user/observability public examples compile/init/close and HTTP replay',
  );
}
