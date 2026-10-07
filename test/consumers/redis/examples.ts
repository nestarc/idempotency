import 'reflect-metadata';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import { IDEMPOTENCY_STORAGE, IdempotencyModule } from '@nestarc/idempotency';
import { RedisStorage } from '@nestarc/idempotency/redis';
import Redis from 'ioredis';
import { verifyModuleRegistrations } from './common/module-examples';

export async function runRedisExamples(
  client: Redis,
  keyPrefix: string,
  connectionString: string,
): Promise<void> {
  const storage = new RedisStorage({ client, keyPrefix });
  await verifyModuleRegistrations(storage);
  assert.equal(await client.ping(), 'PONG');
  console.log(
    'PASS Redis public constructor and registration examples; external client remains open after close',
  );
  await verifyOwnedRedisConnection(connectionString, keyPrefix);
}

async function verifyOwnedRedisConnection(
  connectionString: string,
  keyPrefix: string,
): Promise<void> {
  const createdClients: Redis[] = [];
  const module = await Test.createTestingModule({
    imports: [
      IdempotencyModule.forRootAsync({
        useFactory: async () => ({
          storage: new RedisStorage({
            connection: {
              lazyConnect: true,
              connectTimeout: 5000,
              commandTimeout: 5000,
              maxRetriesPerRequest: 1,
              retryStrategy: () => null,
            },
            // The public factory seam observes the real adapter-owned connection.
            clientFactory: (connection) => {
              const owned = new Redis(connectionString, connection);
              createdClients.push(owned);
              return owned;
            },
            keyPrefix,
          }),
          ttl: 86_400,
          processingTtl: 60,
        }),
      }),
    ],
  }).compile();
  let closed = false;
  try {
    await module.init();
    assert.equal(createdClients.length, 1);
    const owned = createdClients[0];
    const storage = module.get<RedisStorage>(IDEMPOTENCY_STORAGE);
    const record = await storage.create('owned-command', 'owned-fingerprint', 60);
    assert.equal(record.acquired, true);
    assert.equal((await storage.get('owned-command'))?.status, 'PROCESSING');
    assert.ok(record.token);
    assert.equal(await storage.delete('owned-command', record.token), 'ok');
    assert.equal(await storage.get('owned-command'), null);
    const ended = once(owned, 'end', { signal: AbortSignal.timeout(5000) });
    await module.close();
    closed = true;
    await ended;
    assert.equal(owned.status, 'end');
    console.log(
      'PASS async Redis connection example compile/init/real I/O/close; adapter quits owned client',
    );
  } finally {
    try {
      if (!closed) await module.close();
    } finally {
      for (const owned of createdClients) if (owned.status !== 'end') owned.disconnect();
    }
  }
}
