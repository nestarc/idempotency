/**
 * Benchmark driver mocks prove orchestration but cannot prove SQL search_path,
 * Redis prefix isolation, actual replay, or connection cleanup. Exercise the
 * real adapters and protect pre-existing records across success and collisions.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';

import { runBenchmark } from '../../bench/idempotency.bench';
import { parseOptions } from '../../bench/options';
import { createBenchmarkStorage } from '../../bench/storage';
import { PostgresStorage } from '../../src/postgres';

const postgresUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const available = Boolean(postgresUrl && redisUrl);
if (process.env.S5_REQUIRE_REAL_STORAGE === '1' && !available) {
  throw new Error('Real benchmark tests require both TEST_DATABASE_URL and TEST_REDIS_URL');
}
const describeReal = available ? describe : describe.skip;

describeReal('REGRESSION: real benchmark storage isolation', () => {
  let admin: Pool;
  let sentinelPool: Pool;
  let redis: Redis;
  let schema: string;
  let sentinelKey: string;
  let schemaCreated = false;

  beforeAll(async () => {
    schema = `audit_bench_${randomUUID().replace(/-/g, '')}`;
    sentinelKey = `${schema}:untouched`;
    admin = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 5000 });
    redis = new Redis(redisUrl!, {
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 5000,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    redis.on('error', () => undefined);
    await redis.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const connection = new URL(postgresUrl!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    sentinelPool = new Pool({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5000,
    });
    await PostgresStorage.createSchema(sentinelPool);
  });

  afterAll(async () => {
    const results = await Promise.allSettled([
      (async () => {
        try {
          if (redis?.status === 'ready') await redis.del(sentinelKey);
        } finally {
          redis?.disconnect();
        }
      })(),
      (async () => {
        try {
          if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await Promise.all([sentinelPool?.end(), admin?.end()]);
        }
      })(),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures, 'Benchmark fixture cleanup failed');
  });

  it('verifies both HTTP adapters against real services and preserves unrelated records', async () => {
    const sentinel = new PostgresStorage({ pool: sentinelPool });
    const created = await sentinel.create(sentinelKey, 'original-fingerprint', 60);
    expect(created.acquired).toBe(true);
    await expect(
      sentinel.complete(sentinelKey, created.token!, { statusCode: 202, body: 'original' }, 60),
    ).resolves.toBe('ok');
    const original = await sentinel.get(sentinelKey);
    await redis.set(sentinelKey, 'original', 'EX', 60);
    const connection = new URL(postgresUrl!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    const report = await runBenchmark(
      parseOptions(
        ['--adapter', 'both', '--iterations', '2', '--warmup', '0', '--require-services'],
        {
          TEST_DATABASE_URL: connection.toString(),
          TEST_REDIS_URL: redisUrl,
        },
      ),
    );

    expect(report.status).toBe('pass');
    expect(report.cells).toHaveLength(6);
    for (const cell of report.cells) {
      expect(cell).toMatchObject({
        status: 'pass',
        cleanup: 'pass',
        handlerCalls: { baseline: 3, idempotent: 3 },
      });
      expect(cell.scenarios.map((scenario) => scenario.scenario)).toEqual([
        'baseline',
        'first',
        'replay',
      ]);
      for (const scenario of cell.scenarios) expect(scenario.samplesMs).toHaveLength(2);
      if (cell.storage === 'postgres') {
        const result = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
          cell.metadata!.namespace,
        ]);
        expect(result.rowCount).toBe(0);
      } else if (cell.storage === 'redis') {
        const [cursor, keys] = await redis.scan(
          '0',
          'MATCH',
          `${cell.metadata!.namespace}*`,
          'COUNT',
          10000,
        );
        // The fixture is small, but inspect all SCAN pages if other suites add keys.
        let next = cursor;
        const remaining = [...keys];
        while (next !== '0') {
          const page = await redis.scan(
            next,
            'MATCH',
            `${cell.metadata!.namespace}*`,
            'COUNT',
            10000,
          );
          next = page[0];
          remaining.push(...page[1]);
        }
        expect(remaining).toEqual([]);
      }
    }
    expect(await sentinel.get(sentinelKey)).toEqual(original);
    expect(await redis.get(sentinelKey)).toBe('original');
  });

  it('applies the server lock deadline through minimum-driver-compatible startup options', async () => {
    const handle = await createBenchmarkStorage(
      'postgres',
      { postgresUrl, requestTimeoutMs: 777 },
      randomUUID(),
    );
    try {
      const { rows } = await (handle.storage as PostgresStorage).pool.query(
        "SELECT current_setting('lock_timeout') AS deadline, current_schema() AS namespace",
      );
      expect(rows).toEqual([{ deadline: '777ms', namespace: handle.metadata.namespace }]);
    } finally {
      await handle.cleanup();
    }
  });

  it('does not drop an existing PostgreSQL namespace after a failed ownership claim', async () => {
    const id = randomUUID();
    const namespace = `bench_idem_${id.replace(/-/g, '')}`;
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    try {
      await admin.query(`CREATE TABLE "${namespace}".sentinel (value TEXT)`);
      await admin.query(`INSERT INTO "${namespace}".sentinel VALUES ('original')`);
      await expect(
        createBenchmarkStorage('postgres', { postgresUrl, requestTimeoutMs: 5000 }, id),
      ).rejects.toThrow('namespace claim failed');
      expect((await admin.query(`SELECT value FROM "${namespace}".sentinel`)).rows).toEqual([
        { value: 'original' },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
    }
  });

  it('does not delete an existing Redis namespace after a failed ownership claim', async () => {
    const id = randomUUID();
    const prefix = `bench_idem_${id.replace(/-/g, '')}:`;
    await redis.set(`${prefix}__owner`, 'other-run', 'EX', 60);
    await redis.set(`${prefix}record`, 'original', 'EX', 60);
    try {
      await expect(
        createBenchmarkStorage('redis', { redisUrl, requestTimeoutMs: 5000 }, id),
      ).rejects.toThrow('namespace claim failed');
      expect(await redis.mget(`${prefix}__owner`, `${prefix}record`)).toEqual([
        'other-run',
        'original',
      ]);
    } finally {
      await redis.del(`${prefix}__owner`, `${prefix}record`);
    }
  });
});
