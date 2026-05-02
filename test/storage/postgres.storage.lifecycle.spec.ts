/**
 * Lifecycle parity with RedisStorage:
 *  1. PostgresStorage implements OnModuleDestroy.
 *  2. When the storage owns its pool (constructed via `connection` /
 *     `poolFactory`), the hook calls pool.end() exactly once.
 *  3. When the consumer supplied their own `pool`, the hook does NOT
 *     call pool.end().
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { IdempotencyModule } from '../../src/idempotency.module';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

describeOrSkip('PostgresStorage lifecycle', () => {
  it('closes the internally-owned pool via OnModuleDestroy when the Nest app shuts down', async () => {
    let factoryPool: Pool | undefined;

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({
            connection: { connectionString: TEST_DATABASE_URL },
            poolFactory: (cfg): Pool => {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const PgPool = require('pg').Pool;
              factoryPool = new PgPool(cfg) as Pool;
              return factoryPool!;
            },
          }),
        }),
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();

    expect(factoryPool).toBeDefined();
    const endSpy = jest.spyOn(factoryPool!, 'end');

    await app.close();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT close a consumer-supplied pool on shutdown', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require('pg') as typeof import('pg');
    const consumerPool = new Pool({ connectionString: TEST_DATABASE_URL });
    const endSpy = jest.spyOn(consumerPool, 'end');

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({ pool: consumerPool }),
        }),
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await app.close();

    expect(endSpy).not.toHaveBeenCalled();

    await consumerPool.end();
  });
});
