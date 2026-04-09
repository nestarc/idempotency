import { Injectable } from '@nestjs/common';
import type { Redis, RedisOptions } from 'ioredis';

import type {
  CompleteResponse,
  IdempotencyStorage,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';

/**
 * Constructor options for {@link RedisStorage}.
 *
 * Provide either a pre-built `client` (recommended — lets the consumer manage
 * connection lifecycle) OR a `connection` options object that the storage
 * uses to lazily build its own client.
 *
 * `clientFactory` is an injection seam for tests: when supplied, the storage
 * uses it instead of `new Redis(connection)`. This allows tests to substitute
 * `ioredis-mock` without monkey-patching module imports.
 */
export interface RedisStorageOptions {
  /** A pre-built ioredis client. Wins over `connection` if both are supplied. */
  client?: Redis;
  /** ioredis connection options used to lazily construct an internal client. */
  connection?: RedisOptions;
  /** Optional custom factory used in place of `new Redis(connection)`. */
  clientFactory?: (connection: RedisOptions) => Redis;
  /**
   * Prefix prepended to every idempotency key in Redis.
   * @default 'idempotency:'
   */
  keyPrefix?: string;
}

/** The shape persisted as a JSON string under each Redis key. */
interface SerializedRecord {
  key: string;
  fingerprint?: string;
  status: 'PROCESSING' | 'COMPLETED';
  statusCode?: number;
  responseBody?: string;
  createdAt: string; // ISO
  expiresAt: string; // ISO
}

const DEFAULT_KEY_PREFIX = 'idempotency:';

/**
 * Redis-backed implementation of {@link IdempotencyStorage}.
 *
 * Stores each record as a single JSON-serialized string under
 * `${keyPrefix}${key}` and uses `SET ... EX <ttl> NX` for atomic creation
 * (the lock-and-create primitive recommended by the IETF draft and the
 * `@nestarc/idempotency` design notes).
 *
 * Production-safe: shares state across replicas via Redis, and Redis itself
 * handles TTL eviction so no application-level timer bookkeeping is needed.
 */
@Injectable()
export class RedisStorage implements IdempotencyStorage {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly ownsClient: boolean;

  constructor(options: RedisStorageOptions) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;

    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else if (options.connection) {
      const factory =
        options.clientFactory ??
        ((connection: RedisOptions): Redis => {
          // Lazy require so consumers without ioredis installed are unaffected
          // unless they actually try to use this code path.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const RedisCtor = require('ioredis') as new (
            opts: RedisOptions,
          ) => Redis;
          return new RedisCtor(connection);
        });
      this.client = factory(options.connection);
      this.ownsClient = true;
    } else {
      throw new Error(
        'RedisStorage: must supply either `client` or `connection` options',
      );
    }
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.client.get(this.prefixedKey(key));
    if (raw === null) {
      return null;
    }
    return this.deserialize(raw);
  }

  async create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<boolean> {
    const now = new Date();
    const record: SerializedRecord = {
      key,
      fingerprint,
      status: 'PROCESSING',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    // Atomic NX + EX in one round trip — handles the race between two
    // concurrent first-time requests by guaranteeing only one wins.
    const result = await this.client.set(
      this.prefixedKey(key),
      JSON.stringify(record),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async complete(
    key: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const prefixed = this.prefixedKey(key);
    const raw = await this.client.get(prefixed);
    if (raw === null) {
      throw new Error(
        `RedisStorage.complete: record for key "${key}" does not exist`,
      );
    }
    const existing = JSON.parse(raw) as SerializedRecord;
    const now = new Date();
    const updated: SerializedRecord = {
      ...existing,
      status: 'COMPLETED',
      statusCode: response.statusCode,
      responseBody: response.body,
      // createdAt is intentionally preserved.
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    await this.client.set(prefixed, JSON.stringify(updated), 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefixedKey(key));
  }

  /**
   * Closes the internally-managed Redis client. No-op if the client was
   * supplied by the consumer (they own its lifecycle).
   */
  async close(): Promise<void> {
    if (this.ownsClient && typeof this.client.quit === 'function') {
      await this.client.quit();
    }
  }

  private prefixedKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private deserialize(raw: string): IdempotencyRecord {
    const parsed = JSON.parse(raw) as SerializedRecord;
    return {
      key: parsed.key,
      fingerprint: parsed.fingerprint,
      status: parsed.status,
      statusCode: parsed.statusCode,
      responseBody: parsed.responseBody,
      createdAt: new Date(parsed.createdAt),
      expiresAt: new Date(parsed.expiresAt),
    };
  }
}
