/**
 * S7 migration rehearsal. Legacy attempts model 0.4's endpoint address and
 * JSON response format; they do not execute an installed 0.4 package. Real PG
 * tests share a transactional business ledger across separate cache tables.
 * This proves local-database deduplication, not external-provider atomicity.
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'crypto';
import { Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { defer, firstValueFrom } from 'rxjs';

import { IdempotencyInterceptor, MemoryStorage, type IdempotencyStorage } from '../../src';
import { PostgresStorage } from '../../src/postgres';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { encodeReplayBody } from '../../src/utils/replay-body';
import { createRequestKey } from '../../src/utils/request-key';
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';

const owner = 'tenant-42';
const path = '/orders';
const fingerprint = (amount: number): string =>
  createHash('sha256').update(JSON.stringify({ amount })).digest('hex');

function invokeCurrent(
  storage: IdempotencyStorage,
  commandId: string,
  amount: number,
  business: () => Promise<unknown>,
) {
  const handler = function createOrder() {};
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  const { context } = buildExecutionContext({
    handler,
    req: {
      method: 'POST',
      originalUrl: path,
      headers: { 'idempotency-key': commandId },
      body: { amount },
    },
  });
  const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
    storage,
    scope: () => [owner],
  });
  const next = buildCallHandler(defer(business));
  return {
    result: firstValueFrom(interceptor.intercept(context, next)),
    handler: next.handleSpy,
  };
}

async function invokeLegacyFormat(
  storage: IdempotencyStorage,
  commandId: string,
  amount: number,
  business: () => Promise<unknown>,
): Promise<unknown> {
  const key = `POST ${path}::${commandId}`;
  const existing = await storage.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint(amount)) throw new Error('legacy mismatch');
    if (existing.status !== 'COMPLETED') throw new Error('legacy conflict');
    return JSON.parse(existing.responseBody!);
  }
  const lease = await storage.create(key, fingerprint(amount), 60);
  if (!lease.acquired) throw new Error('legacy conflict');
  const result = await business();
  expect(
    await storage.complete(
      key,
      lease.token!,
      { statusCode: 201, body: JSON.stringify(result) },
      60,
    ),
  ).toBe('ok');
  return result;
}

it('demonstrates why an S1 body and v1-looking legacy raw key do not prove record ownership', async () => {
  const shared = new MemoryStorage();
  const fresh = new MemoryStorage();
  try {
    const command = 'order-1';
    const address = createRequestKey(['endpoint', [owner], ['path', 'POST', path]], command).key;
    // An old global caller could choose this complete string as its raw key.
    const lease = await shared.create(address, fingerprint(100), 60);
    await shared.complete(
      address,
      lease.token!,
      { statusCode: 201, body: encodeReplayBody({ owner: 'old-global-caller' }) },
      60,
    );
    const business = jest.fn(async () => ({ owner }));
    const unsafe = invokeCurrent(shared, command, 100, business);
    await expect(unsafe.result).resolves.toEqual({ owner: 'old-global-caller' });
    expect(unsafe.handler).not.toHaveBeenCalled();

    const isolated = invokeCurrent(fresh, command, 100, business);
    await expect(isolated.result).resolves.toEqual({ owner });
    expect(business).toHaveBeenCalledTimes(1);
    expect(await shared.get(address)).not.toBeNull();
  } finally {
    await shared.onModuleDestroy();
    await fresh.onModuleDestroy();
  }
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.S7_REQUIRE_REAL_STORAGE === '1' && !databaseUrl) {
  throw new Error('S7 migration rehearsal requires TEST_DATABASE_URL');
}
const describeReal = databaseUrl ? describe : describe.skip;

describeReal('S7 migration and rollback with a durable PostgreSQL business ledger', () => {
  let pool: Pool;
  const suffix = randomUUID().replace(/-/g, '');
  const legacyTable = `s7_old_${suffix}`;
  const currentTable = `s7_new_${suffix}`;
  const rollbackTable = `s7_rollback_${suffix}`;
  const ledger = `s7_commands_${suffix}`;
  const effects = `s7_effects_${suffix}`;
  const tables = [legacyTable, currentTable, rollbackTable, ledger, effects];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    for (const table of [legacyTable, currentTable, rollbackTable]) {
      await PostgresStorage.createSchema(pool, table);
    }
    await pool.query(`CREATE TABLE "${ledger}" (
      owner TEXT NOT NULL, command_id TEXT NOT NULL, amount INT NOT NULL,
      result JSONB, PRIMARY KEY (owner, command_id)
    )`);
    await pool.query(`CREATE TABLE "${effects}" (
      order_id BIGSERIAL PRIMARY KEY, owner TEXT NOT NULL,
      command_id TEXT NOT NULL, amount INT NOT NULL
    )`);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const table of tables) await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    } finally {
      await pool.end();
    }
  });

  async function createOrder(commandId: string, amount: number): Promise<unknown> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        `INSERT INTO "${ledger}" (owner, command_id, amount)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING command_id`,
        [owner, commandId, amount],
      );
      let result: unknown;
      if (claim.rowCount === 1) {
        const order = await client.query<{ order_id: string }>(
          `INSERT INTO "${effects}" (owner, command_id, amount)
           VALUES ($1, $2, $3) RETURNING order_id`,
          [owner, commandId, amount],
        );
        result = { orderId: order.rows[0].order_id, amount };
        await client.query(
          `UPDATE "${ledger}" SET result = $3 WHERE owner = $1 AND command_id = $2`,
          [owner, commandId, JSON.stringify(result)],
        );
      } else {
        const recorded = await client.query<{ amount: number; result: unknown }>(
          `SELECT amount, result FROM "${ledger}" WHERE owner = $1 AND command_id = $2`,
          [owner, commandId],
        );
        if (recorded.rows[0].amount !== amount) throw new Error('business command mismatch');
        result = recorded.rows[0].result;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('retains one business effect per command through upgrade, replay and rollback', async () => {
    const old = new PostgresStorage({ pool, tableName: legacyTable });
    const current = new PostgresStorage({ pool, tableName: currentTable });
    const rollback = new PostgresStorage({ pool, tableName: rollbackTable });
    const first = await invokeLegacyFormat(old, 'before-upgrade', 100, () =>
      createOrder('before-upgrade', 100),
    );
    const oldRecord = await old.get('POST /orders::before-upgrade');

    // After drain: independent empty namespace, with the same durable ledger.
    const upgraded = invokeCurrent(current, 'before-upgrade', 100, () =>
      createOrder('before-upgrade', 100),
    );
    await expect(upgraded.result).resolves.toEqual(first);
    expect(upgraded.handler).toHaveBeenCalledTimes(1);
    const replay = invokeCurrent(current, 'before-upgrade', 100, () =>
      createOrder('before-upgrade', 100),
    );
    await expect(replay.result).resolves.toEqual(first);
    expect(replay.handler).not.toHaveBeenCalled();
    expect(await old.get('POST /orders::before-upgrade')).toEqual(oldRecord);

    const second = await invokeCurrent(current, 'after-upgrade', 200, () =>
      createOrder('after-upgrade', 200),
    ).result;
    // After another drain: a fresh old-format namespace must still consult
    // the same ledger for commands that the newer release completed.
    await expect(
      invokeLegacyFormat(rollback, 'after-upgrade', 200, () => createOrder('after-upgrade', 200)),
    ).resolves.toEqual(second);
    await expect(
      invokeLegacyFormat(rollback, 'before-upgrade', 100, () => createOrder('before-upgrade', 100)),
    ).resolves.toEqual(first);

    const counts = await pool.query<{ command_id: string; count: number }>(
      `SELECT command_id, count(*)::int AS count FROM "${effects}"
       GROUP BY command_id ORDER BY command_id`,
    );
    expect(counts.rows).toEqual([
      { command_id: 'after-upgrade', count: 1 },
      { command_id: 'before-upgrade', count: 1 },
    ]);
    // Cache namespaces do not carry the parameter checks across versions;
    // the business ledger must reject an altered command even on a cache miss.
    await expect(createOrder('before-upgrade', 999)).rejects.toThrow('business command mismatch');
  });

  it('keeps new replay bodies unreadable to the modeled 0.4 JSON reader', async () => {
    const current = new PostgresStorage({ pool, tableName: currentTable });
    await invokeCurrent(current, 'format-check', 300, async () => ({ safe: true })).result;
    const stored = await pool.query<{ response_body: string }>(
      `SELECT response_body FROM "${currentTable}" WHERE fingerprint = $1`,
      [fingerprint(300)],
    );
    expect(stored.rowCount).toBe(1);
    expect(() => JSON.parse(stored.rows[0].response_body)).toThrow(SyntaxError);
  });
});
