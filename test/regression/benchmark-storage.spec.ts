/**
 * The old benchmark truncated the shared PostgreSQL records table, retained
 * Redis keys, and leaked connections on setup/measurement failures. Dedicated
 * namespaces now require ownership before cleanup; failures reject with no
 * credentials, and cleanup always closes the externally supplied driver.
 */
import Redis from 'ioredis';
import { Pool } from 'pg';

import { BenchmarkStorageSetupError, createBenchmarkStorage } from '../../bench/storage';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('pg', () => ({ Pool: jest.fn() }));

const runId = '9fb1c999-a971-4ed0-bd06-cb71e50f2b3c';
const namespace = 'bench_idem_9fb1c999a9714ed0bd06cb71e50f2b3c';
const prefix = `${namespace}:`;
const options = {
  redisUrl: 'redis://bench:private-secret@localhost:6379/4',
  postgresUrl: 'postgresql://bench:private-secret@localhost:5432/test',
  requestTimeoutMs: 500,
};
const secretError = new Error('Connection failed: private-secret in redis://bench:private-secret');
const mockPoolConstructor = Pool as unknown as jest.Mock;
const mockRedisConstructor = Redis as unknown as jest.Mock;

function postgres() {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('server_version')) return { rows: [{ version: '16.14' }] };
    if (sql.includes('current_schema()')) return { rows: [{ schema: namespace }] };
    return { rows: [] };
  });
  const pool = { query, end: jest.fn(async () => undefined), on: jest.fn() };
  mockPoolConstructor.mockImplementation(() => pool);
  return pool;
}

function redis() {
  const client = {
    on: jest.fn(),
    connect: jest.fn(async () => undefined),
    ping: jest.fn(async () => 'PONG'),
    set: jest.fn(async () => 'OK' as string | null),
    info: jest.fn(async () => '# Server\r\nredis_version:7.2.7\r\n'),
    scan: jest.fn(async (): Promise<[string, string[]]> => ['0', [`${prefix}__owner`]]),
    del: jest.fn(async () => 1),
    disconnect: jest.fn(),
    defineCommand: jest.fn(),
  };
  mockRedisConstructor.mockImplementation(() => client);
  return client;
}

describe('benchmark resource isolation and failure cleanup', () => {
  beforeEach(() => {
    mockPoolConstructor.mockReset();
    mockRedisConstructor.mockReset();
  });

  it('clears Memory timers and records with repeatable cleanup', async () => {
    const handle = await createBenchmarkStorage('memory', options, runId);
    await handle.storage.create('owned-key', 'fingerprint', 60);
    expect(await handle.storage.get('owned-key')).not.toBeNull();
    await handle.cleanup();
    await handle.cleanup();
    expect(await handle.storage.get('owned-key')).toBeNull();
    expect(mockPoolConstructor).not.toHaveBeenCalled();
    expect(mockRedisConstructor).not.toHaveBeenCalled();
  });

  it('rejects unsafe namespace input before opening either optional driver', async () => {
    await expect(
      createBenchmarkStorage('postgres', options, 'public"; DROP TABLE users'),
    ).rejects.toThrow('runId must be a UUID');
    await expect(createBenchmarkStorage('redis', options, '*')).rejects.toThrow(
      'runId must be a UUID',
    );
    expect(mockPoolConstructor).not.toHaveBeenCalled();
    expect(mockRedisConstructor).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN, 1.5, 2_147_483_648])(
    'rejects unbounded timeout %s',
    async (timeout) => {
      await expect(
        createBenchmarkStorage('memory', { ...options, requestTimeoutMs: timeout }, runId),
      ).rejects.toThrow('positive 32-bit integer');
    },
  );

  it('puts all PostgreSQL connections in one owned schema without public fallback', async () => {
    const pool = postgres();
    const handle = await createBenchmarkStorage(
      'postgres',
      {
        ...options,
        postgresUrl: `${options.postgresUrl}?options=-c%20search_path%3Dpublic&query_timeout=0&connectionTimeoutMillis=0`,
      },
      runId,
    );
    const config = mockPoolConstructor.mock.calls[0][0];
    const url = new URL(config.connectionString);
    expect(url.searchParams.get('options')).toBe(`-c search_path=${namespace}`);
    expect(url.searchParams.get('query_timeout')).toBe('500');
    expect(url.searchParams.get('connectionTimeoutMillis')).toBe('500');
    expect(config).toMatchObject({ max: 1, connectionTimeoutMillis: 500, statement_timeout: 500 });
    expect(pool.query).toHaveBeenCalledWith(`CREATE SCHEMA "${namespace}"`);
    expect(handle.metadata).toEqual({ namespace, serverVersion: '16.14' });
    expect(JSON.stringify(handle.metadata)).not.toContain('private-secret');
    await handle.cleanup();
    await handle.cleanup();
    const sql = pool.query.mock.calls.map(([statement]) => statement);
    expect(sql.some((statement) => statement.includes('TRUNCATE'))).toBe(false);
    expect(sql.filter((statement) => statement.startsWith('DROP'))).toEqual([
      `DROP SCHEMA "${namespace}" CASCADE`,
    ]);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('never drops an existing schema when the atomic ownership claim fails', async () => {
    const pool = postgres();
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('CREATE SCHEMA')) throw secretError;
      return { rows: [] };
    });
    await expect(createBenchmarkStorage('postgres', options, runId)).rejects.toThrow(
      'Postgres benchmark namespace claim failed',
    );
    expect(pool.query.mock.calls.some(([sql]) => /DROP|CREATE TABLE|TRUNCATE/.test(sql))).toBe(
      false,
    );
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('drops a claimed schema when table creation fails and closes the pool', async () => {
    const pool = postgres();
    const original = pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE TABLE')) throw secretError;
      return original(sql);
    });
    await expect(createBenchmarkStorage('postgres', options, runId)).rejects.toThrow(
      /^Postgres benchmark initialization failed$/,
    );
    expect(pool.query).toHaveBeenCalledWith(`DROP SCHEMA "${namespace}" CASCADE`);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong search_path before creating any records table', async () => {
    const pool = postgres();
    pool.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('current_schema()') ? [{ schema: 'public' }] : [],
    }));
    await expect(createBenchmarkStorage('postgres', options, runId)).rejects.toThrow(
      'Postgres benchmark initialization failed',
    );
    expect(pool.query.mock.calls.some(([sql]) => /CREATE TABLE|TRUNCATE/.test(sql))).toBe(false);
    expect(pool.query).toHaveBeenCalledWith(`DROP SCHEMA "${namespace}" CASCADE`);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('closes a failed PostgreSQL connection without claiming or deleting a schema', async () => {
    const pool = postgres();
    pool.query.mockRejectedValue(secretError);
    await expect(createBenchmarkStorage('postgres', options, runId)).rejects.toThrow(
      /^Postgres benchmark connection failed$/,
    );
    expect(pool.query.mock.calls.some(([sql]) => /CREATE|DROP|TRUNCATE/.test(sql))).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('reports a PostgreSQL cleanup failure but still closes the external pool', async () => {
    const pool = postgres();
    const handle = await createBenchmarkStorage('postgres', options, runId);
    pool.query.mockRejectedValue(secretError);
    await expect(handle.cleanup()).rejects.toThrow(/^Postgres benchmark cleanup failed;/);
    await expect(handle.cleanup()).rejects.toThrow(/^Postgres benchmark cleanup failed;/);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls.filter(([sql]) => sql.startsWith('DROP'))).toHaveLength(1);
  });

  it('propagates pool closure failures after owned schema cleanup', async () => {
    const pool = postgres();
    const handle = await createBenchmarkStorage('postgres', options, runId);
    pool.end.mockRejectedValue(secretError);
    await expect(handle.cleanup()).rejects.toThrow(/^Postgres benchmark cleanup failed;/);
    expect(pool.query).toHaveBeenCalledWith(`DROP SCHEMA "${namespace}" CASCADE`);
  });

  it('claims and cleans only its Redis prefix across all SCAN pages', async () => {
    const client = redis();
    const handle = await createBenchmarkStorage(
      'redis',
      { ...options, redisUrl: `${options.redisUrl}?keyPrefix=foreign&commandTimeout=0` },
      runId,
    );
    expect(client.set).toHaveBeenCalledWith(
      `${prefix}__owner`,
      'benchmark',
      'PX',
      86_400_000,
      'NX',
    );
    const [connectionString, config] = mockRedisConstructor.mock.calls[0];
    expect(new URL(connectionString).searchParams.has('keyPrefix')).toBe(false);
    expect(new URL(connectionString).searchParams.has('commandTimeout')).toBe(false);
    expect(config).toMatchObject({
      commandTimeout: 500,
      connectTimeout: 500,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      keyPrefix: '',
    });
    expect(config.retryStrategy()).toBeNull();
    expect(config.reconnectOnError()).toBe(false);
    client.scan.mockResolvedValueOnce(['20', [`${prefix}first`]]);
    client.scan.mockResolvedValueOnce(['0', [`${prefix}second`, `${prefix}__owner`]]);
    await handle.cleanup();
    await handle.cleanup();
    expect(client.scan.mock.calls).toEqual([
      ['0', 'MATCH', `${prefix}*`, 'COUNT', 100],
      ['20', 'MATCH', `${prefix}*`, 'COUNT', 100],
    ]);
    expect(client.del.mock.calls).toEqual([
      [`${prefix}first`],
      [`${prefix}second`, `${prefix}__owner`],
    ]);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(handle.metadata).toEqual({ namespace: prefix, serverVersion: '7.2.7' });
  });

  it('does not clean a Redis namespace owned by an earlier run', async () => {
    const client = redis();
    client.set.mockResolvedValue(null);
    await expect(createBenchmarkStorage('redis', options, runId)).rejects.toThrow(
      /^Redis benchmark namespace claim failed$/,
    );
    expect(client.scan).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('closes a failed Redis connection and does not expose its driver error', async () => {
    const client = redis();
    client.connect.mockRejectedValue(secretError);
    await expect(createBenchmarkStorage('redis', options, runId)).rejects.toThrow(
      /^Redis benchmark connection failed$/,
    );
    expect(client.scan).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds Redis connection setup even when the driver never settles', async () => {
    jest.useFakeTimers();
    try {
      const client = redis();
      client.connect.mockImplementation(() => new Promise(() => undefined));
      const pending = createBenchmarkStorage('redis', options, runId);
      const rejected = expect(pending).rejects.toThrow(/^Redis benchmark connection failed$/);
      await jest.advanceTimersByTimeAsync(options.requestTimeoutMs);
      await rejected;
      expect(client.scan).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cleans the owned Redis namespace after later initialization failure', async () => {
    const client = redis();
    client.info.mockRejectedValue(secretError);
    await expect(createBenchmarkStorage('redis', options, runId)).rejects.toThrow(
      /^Redis benchmark initialization failed$/,
    );
    expect(client.del).toHaveBeenCalledWith(`${prefix}__owner`);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails cleanup and disconnects if Redis cannot scan its namespace', async () => {
    const client = redis();
    const handle = await createBenchmarkStorage('redis', options, runId);
    client.scan.mockRejectedValue(secretError);
    await expect(handle.cleanup()).rejects.toThrow(/^Redis benchmark cleanup failed;/);
    await expect(handle.cleanup()).rejects.toThrow(/^Redis benchmark cleanup failed;/);
    expect(client.del).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole Redis cleanup instead of waiting indefinitely for SCAN', async () => {
    const client = redis();
    const handle = await createBenchmarkStorage('redis', options, runId);
    jest.useFakeTimers();
    try {
      client.scan.mockImplementation(() => new Promise(() => undefined));
      const rejected = expect(handle.cleanup()).rejects.toThrow(/^Redis benchmark cleanup failed;/);
      await jest.advanceTimersByTimeAsync(options.requestTimeoutMs);
      await rejected;
      expect(client.del).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains both initialization and cleanup failure context without driver secrets', async () => {
    const client = redis();
    client.info.mockRejectedValue(secretError);
    client.scan.mockRejectedValue(secretError);
    await expect(createBenchmarkStorage('redis', options, runId)).rejects.toThrow(
      /^Redis benchmark initialization failed; isolated namespace cleanup also failed$/,
    );
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete Redis keys outside its declared namespace', async () => {
    const client = redis();
    const handle = await createBenchmarkStorage('redis', options, runId);
    client.scan.mockResolvedValue(['0', ['foreign:key']]);
    await expect(handle.cleanup()).rejects.toThrow(/^Redis benchmark cleanup failed;/);
    expect(client.del).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'reports Redis setup cleanupFailed=%s to the runner',
    async (cleanupFailed) => {
      const client = redis();
      client.info.mockRejectedValue(secretError);
      if (cleanupFailed) client.scan.mockRejectedValue(secretError);
      const failure = await createBenchmarkStorage('redis', options, runId).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(BenchmarkStorageSetupError);
      expect(failure).toMatchObject({ cleanupFailed });
      expect(String(failure)).not.toContain('private-secret');
      expect(failure).not.toHaveProperty('cause');
    },
  );

  it.each([false, true])(
    'reports PostgreSQL setup cleanupFailed=%s to the runner',
    async (cleanupFailed) => {
      const pool = postgres();
      const original = pool.query.getMockImplementation()!;
      pool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('CREATE TABLE') || (cleanupFailed && sql.startsWith('DROP')))
          throw secretError;
        return original(sql);
      });
      const failure = await createBenchmarkStorage('postgres', options, runId).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(BenchmarkStorageSetupError);
      expect(failure).toMatchObject({ cleanupFailed });
      expect(String(failure)).not.toContain('private-secret');
      expect(failure).not.toHaveProperty('cause');
    },
  );
});
