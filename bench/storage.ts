import { MemoryStorage, type IdempotencyStorage } from '../src/index';
import { PostgresStorage } from '../src/postgres';
import { RedisStorage } from '../src/redis';
import type Redis from 'ioredis';
import type { Pool } from 'pg';

export type BenchmarkStorageKind = 'memory' | 'redis' | 'postgres';

export interface BenchmarkStorageOptions {
  redisUrl?: string;
  postgresUrl?: string;
  requestTimeoutMs: number;
}

export interface BenchmarkStorageHandle {
  storage: IdempotencyStorage;
  metadata: Record<string, string>;
  cleanup(): Promise<void>;
}

export class BenchmarkStorageSetupError extends Error {
  constructor(
    message: string,
    readonly cleanupFailed: boolean,
  ) {
    super(message);
    this.name = 'BenchmarkStorageSetupError';
  }
}

function once(operation: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= operation());
}

async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Benchmark storage deadline exceeded')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createRedis(
  options: BenchmarkStorageOptions,
  namespace: string,
): Promise<BenchmarkStorageHandle> {
  let client: Redis | undefined;
  let ownsNamespace = false;
  let stage = 'configuration';
  const prefix = `${namespace}:`;
  const cleanup = once(async () => {
    try {
      if (client && ownsNamespace) {
        const connection = client;
        await deadline(
          (async () => {
            let cursor = '0';
            do {
              const [next, keys] = await connection.scan(
                cursor,
                'MATCH',
                `${prefix}*`,
                'COUNT',
                100,
              );
              cursor = next;
              if (keys.some((key) => !key.startsWith(prefix))) {
                throw new Error('Redis returned a key outside the benchmark namespace');
              }
              if (keys.length) await connection.del(...keys);
            } while (cursor !== '0');
          })(),
          options.requestTimeoutMs,
        );
      }
    } catch {
      throw new Error('Redis benchmark cleanup failed; the isolated namespace may remain');
    } finally {
      // This connection is supplied to RedisStorage, so the harness owns it.
      client?.disconnect();
    }
  });

  try {
    if (!options.redisUrl) throw new Error('Missing Redis URL');
    const url = new URL(options.redisUrl);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid Redis URL');
    // ioredis gives URL parameters precedence over its options argument. Keep
    // callers' connection settings, but never let them disable our deadlines,
    // enable reconnect queues, or introduce a second key prefix.
    for (const key of [
      'lazyConnect',
      'connectTimeout',
      'commandTimeout',
      'maxRetriesPerRequest',
      'retryStrategy',
      'reconnectOnError',
      'enableOfflineQueue',
      'enableReadyCheck',
      'autoResendUnfulfilledCommands',
      'keyPrefix',
    ]) {
      url.searchParams.delete(key);
    }
    stage = 'driver load';
    const { default: RedisClient } = await import('ioredis');
    client = new RedisClient(url.toString(), {
      lazyConnect: true,
      connectTimeout: options.requestTimeoutMs,
      commandTimeout: options.requestTimeoutMs,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      autoResendUnfulfilledCommands: false,
      keyPrefix: '',
    });
    // Driver error events can contain credentials; request promises report a
    // redacted failure instead of ioredis writing them directly to stderr.
    client.on('error', () => undefined);
    stage = 'connection';
    await deadline(client.connect(), options.requestTimeoutMs);
    if ((await client.ping()) !== 'PONG') throw new Error('Redis ping failed');
    stage = 'namespace claim';
    const claimed = await client.set(`${prefix}__owner`, 'benchmark', 'PX', 86_400_000, 'NX');
    if (claimed !== 'OK') throw new Error('Benchmark namespace already exists');
    ownsNamespace = true;
    stage = 'initialization';
    const info = await client.info('server');
    const version = /^redis_version:([^\r\n]+)$/m.exec(info)?.[1] ?? 'unknown';
    const storage = new RedisStorage({ client, keyPrefix: prefix });
    return { storage, cleanup, metadata: { namespace: prefix, serverVersion: version } };
  } catch {
    let cleanupFailed = false;
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
    throw new BenchmarkStorageSetupError(
      `Redis benchmark ${stage} failed${cleanupFailed ? '; isolated namespace cleanup also failed' : ''}`,
      cleanupFailed,
    );
  }
}

async function createPostgres(
  options: BenchmarkStorageOptions,
  namespace: string,
): Promise<BenchmarkStorageHandle> {
  let pool: Pool | undefined;
  let ownsNamespace = false;
  let stage = 'configuration';
  const cleanup = once(async () => {
    let failed = false;
    try {
      // Only a successful non-idempotent CREATE SCHEMA grants ownership.
      // Existing schemas and the default records table must never be touched.
      if (pool && ownsNamespace) await pool.query(`DROP SCHEMA "${namespace}" CASCADE`);
    } catch {
      failed = true;
    } finally {
      try {
        await pool?.end();
      } catch {
        failed = true;
      }
    }
    if (failed) {
      throw new Error('Postgres benchmark cleanup failed; the isolated schema may remain');
    }
  });

  try {
    if (!options.postgresUrl) throw new Error('Missing Postgres URL');
    const url = new URL(options.postgresUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol))
      throw new Error('Invalid Postgres URL');
    // pg lets connection-string parameters override Pool options. The startup
    // search_path applies to every connection and has no public fallback.
    url.searchParams.set('options', `-c search_path=${namespace}`);
    for (const key of [
      'statement_timeout',
      'query_timeout',
      'lock_timeout',
      'connectionTimeoutMillis',
    ]) {
      url.searchParams.set(key, String(options.requestTimeoutMs));
    }
    stage = 'driver load';
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: options.requestTimeoutMs,
      idleTimeoutMillis: options.requestTimeoutMs,
      statement_timeout: options.requestTimeoutMs,
      query_timeout: options.requestTimeoutMs,
      lock_timeout: options.requestTimeoutMs,
      application_name: 'idempotency-benchmark',
    });
    pool.on('error', () => undefined);
    stage = 'connection';
    const version = await pool.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    stage = 'namespace claim';
    await pool.query(`CREATE SCHEMA "${namespace}"`);
    ownsNamespace = true;
    stage = 'initialization';
    const current = await pool.query<{ schema: string }>('SELECT current_schema() AS schema');
    if (current.rows[0]?.schema !== namespace) throw new Error('Incorrect benchmark search_path');
    await PostgresStorage.createSchema(pool);
    const storage = new PostgresStorage({ pool });
    return {
      storage,
      cleanup,
      metadata: { namespace, serverVersion: version.rows[0]?.version ?? 'unknown' },
    };
  } catch {
    let cleanupFailed = false;
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
    throw new BenchmarkStorageSetupError(
      `Postgres benchmark ${stage} failed${cleanupFailed ? '; isolated schema cleanup also failed' : ''}`,
      cleanupFailed,
    );
  }
}

export async function createBenchmarkStorage(
  kind: BenchmarkStorageKind,
  options: BenchmarkStorageOptions,
  runId: string,
): Promise<BenchmarkStorageHandle> {
  // Namespace input is never interpolated into SQL or Redis patterns until it
  // has been restricted to the fixed-length UUID form generated by the runner.
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(runId)) {
    throw new Error('Benchmark runId must be a UUID');
  }
  if (
    !Number.isSafeInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs <= 0 ||
    options.requestTimeoutMs > 2_147_483_647
  ) {
    throw new Error('Benchmark storage timeout must be a positive 32-bit integer');
  }
  const namespace = `bench_idem_${runId.replace(/-/g, '').toLowerCase()}`;
  if (kind === 'memory') {
    const storage = new MemoryStorage();
    return { storage, cleanup: once(() => storage.onModuleDestroy()), metadata: {} };
  }
  if (kind === 'redis') return createRedis(options, namespace);
  if (kind === 'postgres') return createPostgres(options, namespace);
  throw new Error('Unknown benchmark storage kind');
}
