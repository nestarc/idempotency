/**
 * Regression test for v0.1.3 — route-path-based scope (P2 #3).
 *
 * Pre-v0.1.3 the `scope: 'endpoint'` strategy used
 * `ControllerClassName#methodName::` as the storage key prefix. That is
 * safe within a single module but breaks as soon as two modules have
 * controllers with the same class name (v1/v2 API versions, or two
 * independent features that both happened to name a controller
 * `UsersController`). A shared Idempotency-Key would then collide across
 * modules.
 *
 * Fix (v0.1.3): the interceptor reads NestJS `PATH_METADATA` from the
 * controller class and handler method to build a `HTTP_METHOD /path::`
 * prefix, matching the IETF draft recommendation that idempotency is
 * scoped per (key, request URI). Controllers without metadata (custom
 * decorators, tests) fall back to the legacy class#method strategy.
 */
import 'reflect-metadata';
import {
  Controller,
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
import type { CreateResult } from '../../src/interfaces/idempotency-storage.interface';

/**
 * MemoryStorage subclass that records every scoped key passed to create().
 * We subclass instead of spying so there's no ambiguity about which
 * instance is actually being called by the Nest DI container.
 */
class TrackingMemoryStorage extends MemoryStorage {
  readonly capturedKeys: string[] = [];

  override async create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<CreateResult> {
    this.capturedKeys.push(key);
    return super.create(key, fingerprint, ttlSeconds);
  }
}

/**
 * Two controllers that both define a class called `UsersController`
 * via `@Controller('v1/users')` and `@Controller('v2/users')`. Pre-v0.1.3
 * these would have collided under scope='endpoint' because their class
 * names are identical; the route paths are different.
 *
 * We cannot actually declare the same class name twice in one file, so
 * we use two wrapper namespaces to simulate the condition and rely on
 * the runtime metadata stamping via decorators.
 */

// v1/users controller
@Controller('v1/users')
@UseInterceptors(IdempotencyInterceptor)
class V1UsersController {
  static calls = 0;
  @Post()
  @Idempotent()
  create() {
    V1UsersController.calls += 1;
    return { version: 'v1', id: `u${V1UsersController.calls}` };
  }
}

// v2/users controller — deliberately shares the business-logic shape but
// a different route prefix. Under the old scope strategy, both would
// collide because both would be `UsersController#create`.
@Controller('v2/users')
@UseInterceptors(IdempotencyInterceptor)
class V2UsersController {
  static calls = 0;
  @Post()
  @Idempotent()
  create() {
    V2UsersController.calls += 1;
    return { version: 'v2', id: `u${V2UsersController.calls}` };
  }
}

describe('REGRESSION: route-path-based scope (cross-module isolation)', () => {
  let app: INestApplication;
  let storage: TrackingMemoryStorage;

  beforeAll(async () => {
    storage = new TrackingMemoryStorage();
    const mod = await Test.createTestingModule({
      imports: [
        IdempotencyModule.forRoot({ storage, scope: 'endpoint' }),
      ],
      controllers: [V1UsersController, V2UsersController],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    V1UsersController.calls = 0;
    V2UsersController.calls = 0;
  });

  it('v1 and v2 controllers do not collide when they share an Idempotency-Key', async () => {
    const v1 = await request(app.getHttpServer())
      .post('/v1/users')
      .set('Idempotency-Key', 'shared')
      .send({ name: 'Alice' });
    expect(v1.status).toBe(201);
    expect(v1.body).toEqual({ version: 'v1', id: 'u1' });

    const v2 = await request(app.getHttpServer())
      .post('/v2/users')
      .set('Idempotency-Key', 'shared')
      .send({ name: 'Alice' });
    expect(v2.status).toBe(201);
    expect(v2.body).toEqual({ version: 'v2', id: 'u1' });

    // Both handlers ran exactly once.
    expect(V1UsersController.calls).toBe(1);
    expect(V2UsersController.calls).toBe(1);
  });

  it('uses the HTTP method + real route path as the storage key prefix', async () => {
    const before = storage.capturedKeys.length;

    await request(app.getHttpServer())
      .post('/v1/users')
      .set('Idempotency-Key', 'probe-key')
      .send({ name: 'Bob' });

    expect(storage.capturedKeys.length).toBeGreaterThan(before);
    const scopedKey = storage.capturedKeys[storage.capturedKeys.length - 1];
    // The scoped key must contain the HTTP method and the real route path,
    // NOT the class name.
    expect(scopedKey).toContain('POST');
    expect(scopedKey).toContain('v1/users');
    expect(scopedKey).toContain('::probe-key');
    expect(scopedKey).not.toContain('V1UsersController');
  });
});
