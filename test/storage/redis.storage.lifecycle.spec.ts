/**
 * Regression test for the SOLID/LSP finding that RedisStorage leaked
 * its internal client on Nest shutdown.
 *
 * Guarantees:
 * 1. `RedisStorage` implements `OnModuleDestroy` so Nest calls it
 *    automatically on `app.close()`.
 * 2. When the storage owns its client (constructed via `connection` or
 *    `clientFactory`), the hook closes it exactly once.
 * 3. When the consumer supplied their own `client`, the hook does NOT
 *    close it — lifecycle stays with the consumer.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { RedisStorage } from '../../src/storage/redis.storage';
import { IdempotencyModule } from '../../src/idempotency.module';

describe('RedisStorage lifecycle', () => {
  it('closes the internally-owned client via OnModuleDestroy when the Nest app shuts down', async () => {
    // We use a spy factory that returns a mock client whose `quit` method is
    // a jest.fn so we can assert on call count after shutdown.
    const mockClient = new (RedisMock as any)() as Redis;
    const quitSpy = jest.spyOn(mockClient, 'quit');

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new RedisStorage({
            connection: { host: 'localhost', port: 6379 },
            clientFactory: () => mockClient,
          }),
        }),
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    expect(quitSpy).not.toHaveBeenCalled();

    await app.close();

    // Nest fired onModuleDestroy on the storage instance, which delegated
    // to close(), which called quit() on the owned client.
    expect(quitSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT close a consumer-supplied client on shutdown', async () => {
    // When the consumer passes their own client, RedisStorage must NOT
    // touch its lifecycle — the consumer retains ownership.
    const mockClient = new (RedisMock as any)() as Redis;
    const quitSpy = jest.spyOn(mockClient, 'quit');

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new RedisStorage({ client: mockClient }),
        }),
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await app.close();

    expect(quitSpy).not.toHaveBeenCalled();

    // Consumer cleans up themselves.
    await mockClient.quit();
  });

  it('MemoryStorage also implements OnModuleDestroy and gets called by Nest', async () => {
    // Sibling regression — ensure MemoryStorage stays consistent.
    const memoryStorageModule = await import('../../src/storage/memory.storage');
    const storage = new memoryStorageModule.MemoryStorage();
    const destroySpy = jest.spyOn(storage, 'onModuleDestroy');

    @Module({
      imports: [IdempotencyModule.forRoot({ storage })],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await app.close();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
