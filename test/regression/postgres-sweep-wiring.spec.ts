/**
 * Regression: the README registered PostgresSweepService beside an
 * IdempotencyModule, but Nest could not compile that module: the service
 * requested the PostgresStorage class while the module exported only
 * IDEMPOTENCY_STORAGE. Injecting that public token reuses the configured
 * adapter for both registration modes without adding a second Pool or
 * importing PostgreSQL into the driver-free root module.
 *
 * The connection-free cases pin compilation and timer/storage lifecycle;
 * TEST_DATABASE_URL additionally checks real row cleanup and that the
 * consumer's Pool is still usable after Nest closes.
 */
import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { IDEMPOTENCY_STORAGE, IDEMPOTENCY_SWEEP_OPTIONS, IdempotencyModule } from '../../src';
import { PostgresStorage, PostgresSweepService } from '../../src/postgres';

const registrations: {
  name: string;
  register: (storage: PostgresStorage) => DynamicModule;
}[] = [
  {
    name: 'forRoot (README sweep example)',
    register: (storage) => IdempotencyModule.forRoot({ storage }),
  },
  {
    name: 'forRootAsync',
    register: (storage) =>
      IdempotencyModule.forRootAsync({
        useFactory: async () => ({ storage }),
      }),
  },
];

async function compileExample(
  storage: PostgresStorage,
  register: (storage: PostgresStorage) => DynamicModule,
): Promise<TestingModule> {
  @Module({
    imports: [register(storage)],
    providers: [
      PostgresSweepService,
      {
        provide: IDEMPOTENCY_SWEEP_OPTIONS,
        useValue: { enabled: true, intervalMs: 60_000 },
      },
    ],
  })
  class AppModule {}

  return Test.createTestingModule({ imports: [AppModule] }).compile();
}

describe('PostgresSweepService documented Nest wiring', () => {
  it.each(registrations)(
    '$name compiles, initializes and closes with the same externally owned Pool',
    async ({ register }) => {
      jest.useFakeTimers();
      const pool = new Pool();
      const end = jest.spyOn(pool, 'end');
      const storage = new PostgresStorage({ pool });
      const destroy = jest.spyOn(storage, 'onModuleDestroy');
      let mod: TestingModule | undefined;
      try {
        mod = await compileExample(storage, register);
        expect(mod.get(IDEMPOTENCY_STORAGE)).toBe(storage);
        const sweep = jest
          .spyOn(mod.get(PostgresSweepService), 'sweep')
          .mockResolvedValue({ deleted: 0 });

        await mod.init();
        expect(jest.getTimerCount()).toBe(1);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(sweep).toHaveBeenCalledTimes(1);

        await mod.close();
        mod = undefined;
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(end).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(120_000);
        expect(sweep).toHaveBeenCalledTimes(1);
      } finally {
        await mod?.close();
        await pool.end();
        jest.useRealTimers();
      }
    },
  );
});

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = DATABASE_URL ? describe : describe.skip;

describeReal('PostgresSweepService documented wiring against real PostgreSQL', () => {
  it.each(registrations)(
    '$name removes expired rows and leaves the external Pool usable after close',
    async ({ register }) => {
      const pool = new Pool({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
      });
      const end = jest.spyOn(pool, 'end');
      const tableName = `idempotency_s7_sweep_${randomUUID().replace(/-/g, '')}`;
      const storage = new PostgresStorage({
        pool,
        tableName,
        autoCreateSchema: true,
      });
      let mod: TestingModule | undefined;
      let fixtureLock: PoolClient | undefined;
      try {
        // The service uses a global advisory key. Coordinate with the real
        // service spec so parallel Jest workers cannot skip each other's sweep.
        fixtureLock = await pool.connect();
        await fixtureLock.query(
          "SELECT pg_advisory_lock(hashtext('idempotency-test-sweep-fixture'))",
        );
        mod = await compileExample(storage, register);
        await mod.init();
        await pool.query(
          `INSERT INTO "${tableName}" (key, token, status, expires_at)
           VALUES ('expired', $1, 'PROCESSING', now() - interval '1 second'),
                  ('live', $2, 'PROCESSING', now() + interval '1 hour')`,
          [randomUUID(), randomUUID()],
        );

        await expect(mod.get(PostgresSweepService).sweep()).resolves.toEqual({
          deleted: 1,
        });
        const remaining = await pool.query<{ key: string }>(
          `SELECT key FROM "${tableName}" ORDER BY key`,
        );
        expect(remaining.rows).toEqual([{ key: 'live' }]);

        await mod.close();
        mod = undefined;
        expect(end).not.toHaveBeenCalled();
        const stillOpen = await pool.query<{ value: number }>('SELECT 1 AS value');
        expect(stillOpen.rows).toEqual([{ value: 1 }]);
      } finally {
        await mod?.close();
        try {
          await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
        } finally {
          try {
            if (fixtureLock) {
              await fixtureLock.query(
                "SELECT pg_advisory_unlock(hashtext('idempotency-test-sweep-fixture'))",
              );
            }
          } finally {
            fixtureLock?.release();
            await pool.end();
          }
        }
      }
    },
  );
});
