import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  IDEMPOTENCY_STORAGE,
  IDEMPOTENCY_SWEEP_OPTIONS,
  IdempotencyModule,
} from '@nestarc/idempotency';
import {
  PostgresStorage,
  PostgresSweepService,
  type SweepOptions,
} from '@nestarc/idempotency/postgres';
import { Pool } from 'pg';
import { verifyModuleRegistrations } from './common/module-examples';

export async function runPostgresExamples(
  pool: Pool,
  tableName: string,
  connectionString: string,
): Promise<void> {
  const storage = new PostgresStorage({ pool, tableName, autoCreateSchema: true });
  await verifyModuleRegistrations(storage);
  const sweepOptions: SweepOptions = { enabled: true, intervalMs: 60_000 };

  @Module({
    imports: [IdempotencyModule.forRoot({ storage })],
    providers: [
      PostgresSweepService,
      { provide: IDEMPOTENCY_SWEEP_OPTIONS, useValue: sweepOptions },
    ],
  })
  class AppModule {}

  // No PostgresStorage class provider and no second Pool: this is the README wiring.
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  try {
    await module.init();
    assert.equal(module.get(IDEMPOTENCY_STORAGE), storage);
    assert.equal(module.get<PostgresStorage>(IDEMPOTENCY_STORAGE).pool, pool);
    const retained = await pool.query<{ key: string }>(
      `SELECT key FROM "${tableName}" ORDER BY key`,
    );
    assert.equal((await storage.create('sweep-expired', 'expired', 60)).acquired, true);
    assert.equal((await storage.create('sweep-active', 'active', 60)).acquired, true);
    // Make one row expired in the database without triggering lazy get() cleanup.
    // tableName is generated locally from randomUUID by runtime.cjs.
    assert.match(tableName, /^consumer_[a-f0-9]+$/);
    await pool.query(
      `UPDATE "${tableName}" SET expires_at = now() - interval '1 second' WHERE key = $1`,
      ['sweep-expired'],
    );
    assert.equal((await module.get(PostgresSweepService).sweep()).deleted, 1);
    const rows = await pool.query<{ key: string }>(`SELECT key FROM "${tableName}" ORDER BY key`);
    assert.deepEqual(
      rows.rows.map((row) => row.key),
      [...retained.rows.map((row) => row.key), 'sweep-active'].sort(),
    );
  } finally {
    await module.close();
  }
  await pool.query('SELECT 1');
  console.log(
    'PASS Postgres sweep example compile/init/delete expired row/close; external Pool remains open',
  );
  await verifyOwnedPostgresConnection(connectionString, tableName);
}

async function verifyOwnedPostgresConnection(
  connectionString: string,
  tableName: string,
): Promise<void> {
  const createdPools: Pool[] = [];
  const module = await Test.createTestingModule({
    imports: [
      IdempotencyModule.forRootAsync({
        useFactory: async () => ({
          storage: new PostgresStorage({
            connection: {
              connectionString,
              connectionTimeoutMillis: 5000,
              query_timeout: 5000,
              max: 1,
            },
            // The public factory seam observes the real adapter-owned connection.
            poolFactory: (connection) => {
              const owned = new Pool(connection);
              createdPools.push(owned);
              return owned;
            },
            tableName,
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
    assert.equal(createdPools.length, 1);
    const owned = createdPools[0];
    const storage = module.get<PostgresStorage>(IDEMPOTENCY_STORAGE);
    assert.equal(storage.pool, owned);
    const record = await storage.create('owned-command', 'owned-fingerprint', 60);
    assert.equal(record.acquired, true);
    assert.equal((await storage.get('owned-command'))?.status, 'PROCESSING');
    assert.ok(record.token);
    assert.equal(await storage.delete('owned-command', record.token), 'ok');
    assert.equal(await storage.get('owned-command'), null);
    await module.close();
    closed = true;
    await assert.rejects(owned.query('SELECT 1'), /Cannot use a pool after calling end/);
    console.log(
      'PASS async Postgres connection example compile/init/real I/O/close; adapter ends owned Pool',
    );
  } finally {
    try {
      if (!closed) await module.close();
    } finally {
      for (const owned of createdPools) {
        // Use public API behavior; pg 8.11's declarations do not expose ending/ended.
        await owned.end().catch((error: Error) => {
          assert.match(error.message, /Called end on pool more than once/);
        });
      }
    }
  }
}
