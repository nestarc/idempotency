import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Redis, RedisOptions } from 'ioredis';

import type {
  CompleteResponse,
  CreateResult,
  IdempotencyStorage,
  MutateResult,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';

/**
 * Constructor options for {@link RedisStorage}.
 *
 * Provide either a pre-built `client` (recommended — lets the consumer manage
 * connection lifecycle) OR a `connection` options object that the storage
 * uses to lazily build its own client.
 */
export interface RedisStorageOptions {
  /** A pre-built ioredis client. Wins over `connection` if both are supplied. */
  client?: Redis;
  /** ioredis connection options used to lazily construct an internal client. */
  connection?: RedisOptions;
  /** Test-only seam: custom factory used in place of `new Redis(connection)`. */
  clientFactory?: (connection: RedisOptions) => Redis;
  /**
   * Prefix prepended to every idempotency key in Redis.
   * @default 'idempotency:'
   */
  keyPrefix?: string;
}

/** Persisted as a Redis Hash under each prefixed key. */
interface SerializedPayload {
  fingerprint?: string;
  status: 'PROCESSING' | 'COMPLETED';
  statusCode?: number;
  responseBody?: string;
  createdAt: string; // ISO
  expiresAt: string; // ISO
}

const DEFAULT_KEY_PREFIX = 'idempotency:';

// ioredis's custom command typing is looser than the declared Redis class.
// We widen the client type locally so the injected Lua commands are callable.
type RedisWithIdem = Redis & {
  idemCreate(
    key: string,
    token: string,
    payload: string,
    ttl: string,
  ): Promise<number>;
  idemComplete(
    key: string,
    token: string,
    payload: string,
    ttl: string,
  ): Promise<string>;
  idemDelete(key: string, token: string): Promise<string>;
};

/**
 * Redis-backed implementation of {@link IdempotencyStorage}.
 *
 * Stores each record as a Redis Hash under `${keyPrefix}${key}` with two
 * fields: `token` (opaque UUID owned by the creating caller) and `payload`
 * (JSON-serialized {@link SerializedPayload}). All mutations go through
 * Lua scripts registered with `defineCommand` so the compare-and-set logic
 * runs atomically on the Redis server — closing the race window that a
 * GET-then-SET pattern would leave open.
 */
@Injectable()
export class RedisStorage implements IdempotencyStorage, OnModuleDestroy {
  private readonly client: RedisWithIdem;
  private readonly keyPrefix: string;
  private readonly ownsClient: boolean;

  constructor(options: RedisStorageOptions) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;

    let baseClient: Redis;
    if (options.client) {
      baseClient = options.client;
      this.ownsClient = false;
    } else if (options.connection) {
      const factory =
        options.clientFactory ??
        ((connection: RedisOptions): Redis => {
          // Lazy require so consumers without ioredis installed are unaffected
          // unless they actually exercise this code path.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const RedisCtor = require('ioredis') as new (
            opts: RedisOptions,
          ) => Redis;
          return new RedisCtor(connection);
        });
      baseClient = factory(options.connection);
      this.ownsClient = true;
    } else {
      throw new Error(
        'RedisStorage: must supply either `client` or `connection` options',
      );
    }

    RedisStorage.registerCommands(baseClient);
    this.client = baseClient as RedisWithIdem;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const hash = await this.client.hgetall(this.prefixedKey(key));
    if (!hash || !hash.token || !hash.payload) {
      return null;
    }
    const payload = JSON.parse(hash.payload) as SerializedPayload;
    return {
      key,
      token: hash.token,
      fingerprint: payload.fingerprint,
      status: payload.status,
      statusCode: payload.statusCode,
      responseBody: payload.responseBody,
      createdAt: new Date(payload.createdAt),
      expiresAt: new Date(payload.expiresAt),
    };
  }

  async create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<CreateResult> {
    const token = randomUUID();
    const now = new Date();
    const payload: SerializedPayload = {
      fingerprint,
      status: 'PROCESSING',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    const result = await this.client.idemCreate(
      this.prefixedKey(key),
      token,
      JSON.stringify(payload),
      String(ttlSeconds),
    );
    if (result === 1) {
      return { acquired: true, token };
    }
    return { acquired: false };
  }

  async complete(
    key: string,
    token: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<MutateResult> {
    // Need the existing createdAt to preserve it. HGET is a separate round
    // trip but the Lua CAS still guarantees we only overwrite our own record.
    const hash = await this.client.hgetall(this.prefixedKey(key));
    if (!hash || !hash.token || hash.token !== token || !hash.payload) {
      return 'stale';
    }
    const existing = JSON.parse(hash.payload) as SerializedPayload;
    const now = new Date();
    const updated: SerializedPayload = {
      ...existing,
      status: 'COMPLETED',
      statusCode: response.statusCode,
      responseBody: response.body,
      // createdAt intentionally preserved across complete().
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    const result = await this.client.idemComplete(
      this.prefixedKey(key),
      token,
      JSON.stringify(updated),
      String(ttlSeconds),
    );
    return result === 'ok' ? 'ok' : 'stale';
  }

  async delete(key: string, token: string): Promise<MutateResult> {
    const result = await this.client.idemDelete(this.prefixedKey(key), token);
    return result === 'ok' ? 'ok' : 'stale';
  }

  /**
   * Closes the internally-managed Redis client. No-op if the client was
   * supplied by the consumer (they own its lifecycle).
   *
   * Normally called automatically via `onModuleDestroy()` during Nest's
   * shutdown. Exposed publicly so non-Nest consumers (or manual teardown
   * in tests) can trigger the cleanup without going through the module
   * lifecycle.
   */
  async close(): Promise<void> {
    if (this.ownsClient && typeof this.client.quit === 'function') {
      await this.client.quit();
    }
  }

  /**
   * Nest lifecycle hook — fires automatically when the host module is
   * destroyed (e.g. during `app.close()`). Delegates to {@link close}
   * so consumers who pass only `connection` options (letting this class
   * own the client) get graceful teardown without manual bookkeeping.
   *
   * If the consumer supplied their own `client`, this hook is a no-op:
   * they remain responsible for closing what they created.
   */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private prefixedKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Registers the three Lua commands that enforce compare-and-set semantics
   * on the Redis server. Called once per client during construction; ioredis
   * tolerates re-registration so repeated calls are safe.
   */
  private static registerCommands(client: Redis): void {
    client.defineCommand('idemCreate', {
      numberOfKeys: 1,
      lua: `
        if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
        redis.call('HSET', KEYS[1], 'token', ARGV[1], 'payload', ARGV[2])
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
        return 1
      `,
    });
    client.defineCommand('idemComplete', {
      numberOfKeys: 1,
      lua: `
        local token = redis.call('HGET', KEYS[1], 'token')
        if not token then return 'stale' end
        if token ~= ARGV[1] then return 'stale' end
        redis.call('HSET', KEYS[1], 'payload', ARGV[2])
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
        return 'ok'
      `,
    });
    client.defineCommand('idemDelete', {
      numberOfKeys: 1,
      lua: `
        local token = redis.call('HGET', KEYS[1], 'token')
        if not token then return 'ok' end
        if token ~= ARGV[1] then return 'stale' end
        redis.call('DEL', KEYS[1])
        return 'ok'
      `,
    });
  }
}
