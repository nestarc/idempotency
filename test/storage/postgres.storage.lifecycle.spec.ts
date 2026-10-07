/**
 * Verify Nest closes an actual owned PostgreSQL connection while leaving a
 * consumer-owned pool usable. A spy on an unopened pool cannot establish this.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { IdempotencyModule } from '../../src/idempotency.module';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;
const connection = {
  connectionString: TEST_DATABASE_URL,
  connectionTimeoutMillis: 2000,
  query_timeout: 3000,
};

describeOrSkip('PostgresStorage lifecycle', () => {
  it('closes the internally-owned pool via OnModuleDestroy when the Nest app shuts down', async () => {
    let factoryPool: Pool | undefined;
    const storage = new PostgresStorage({
      connection,
      poolFactory: (config) => {
        factoryPool = new Pool(config);
        return factoryPool;
      },
    });
    const pool = factoryPool!;
    const endSpy = jest.spyOn(pool, 'end');
    const mod = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ storage })],
    }).compile();
    const app = mod.createNestApplication();
    let closed = false;
    try {
      await app.init();
      expect((await pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
      expect(pool.totalCount).toBeGreaterThan(0);
      expect(endSpy).not.toHaveBeenCalled();

      await app.close();
      closed = true;
      expect(endSpy).toHaveBeenCalledTimes(1);
      expect(pool.totalCount).toBe(0);
      await expect(pool.query('SELECT 1')).rejects.toThrow(/after calling end/);
    } finally {
      try {
        if (!closed) await app.close();
      } finally {
        if (endSpy.mock.calls.length === 0) await pool.end();
      }
    }
  });

  it('leaves a consumer-supplied pool usable after Nest shutdown', async () => {
    const consumerPool = new Pool(connection);
    const endSpy = jest.spyOn(consumerPool, 'end');
    const storage = new PostgresStorage({ pool: consumerPool });
    const mod = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ storage })],
    }).compile();
    const app = mod.createNestApplication();
    let closed = false;
    try {
      await app.init();
      expect((await consumerPool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
      await app.close();
      closed = true;

      expect(endSpy).not.toHaveBeenCalled();
      expect((await consumerPool.query('SELECT 2 AS value')).rows).toEqual([{ value: 2 }]);
    } finally {
      try {
        if (!closed) await app.close();
      } finally {
        if (endSpy.mock.calls.length === 0) await consumerPool.end();
      }
    }
  });
});
