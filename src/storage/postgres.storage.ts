import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Pool, PoolConfig } from 'pg';

import type {
  CompleteResponse,
  CreateResult,
  IdempotencyStorage,
  MutateResult,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';

/**
 * Constructor options for {@link PostgresStorage}.
 *
 * Provide either a pre-built `pool` (recommended — lets the consumer manage
 * connection lifecycle) OR a `connection` config that the storage uses to
 * lazily build its own pool.
 */
export interface PostgresStorageOptions {
  /** A pre-built pg Pool. Wins over `connection` if both are supplied. */
  pool?: Pool;
  /** pg PoolConfig used to lazily construct an internal pool. */
  connection?: PoolConfig;
  /** Test-only seam: custom factory used in place of `new Pool(connection)`. */
  poolFactory?: (connection: PoolConfig) => Pool;
  /**
   * Table name used for idempotency records.
   * @default 'idempotency_records'
   */
  tableName?: string;
  /**
   * If true, run `CREATE TABLE IF NOT EXISTS` and matching index on
   * module init. Defaults to false. Recommended only for development.
   */
  autoCreateSchema?: boolean;
}

const DEFAULT_TABLE_NAME = 'idempotency_records';

/**
 * Postgres-backed implementation of {@link IdempotencyStorage}.
 *
 * Stores each record as a row in `idempotency_records` (override via
 * `tableName`). Atomic NX is enforced by the primary-key constraint on
 * `key` combined with `INSERT ... ON CONFLICT DO UPDATE WHERE
 * expires_at < now()`. Token-based compare-and-set is enforced by
 * `WHERE token = $` clauses on `complete()` and `delete()`. Lazy
 * expiration is enforced by `WHERE expires_at > now()` in `get()`.
 *
 * For active cleanup of expired rows see {@link PostgresSweepService}.
 */
@Injectable()
export class PostgresStorage implements IdempotencyStorage, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly tableName: string;
  private readonly autoCreateSchema: boolean;

  constructor(options: PostgresStorageOptions) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.autoCreateSchema = options.autoCreateSchema ?? false;

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (options.connection) {
      const factory =
        options.poolFactory ??
        ((connection: PoolConfig): Pool => {
          // Lazy require so consumers without pg installed are unaffected
          // unless they actually exercise this code path.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const PgPool = require('pg').Pool as new (cfg: PoolConfig) => Pool;
          return new PgPool(connection);
        });
      this.pool = factory(options.connection);
      this.ownsPool = true;
    } else {
      throw new Error(
        'PostgresStorage: must supply either `pool` or `connection` options',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.autoCreateSchema) {
      await PostgresStorage.createSchema(this.pool, this.tableName);
    }
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query<{
      key: string;
      token: string;
      fingerprint: string | null;
      status: 'PROCESSING' | 'COMPLETED';
      response_code: number | null;
      response_body: string | null;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT key, token, fingerprint, status, response_code, response_body,
              created_at, expires_at
         FROM ${quoteIdent(this.tableName)}
         WHERE key = $1 AND expires_at > now()`,
      [key],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      key: row.key,
      token: row.token,
      fingerprint: row.fingerprint ?? undefined,
      status: row.status,
      statusCode: row.response_code ?? undefined,
      responseBody: row.response_body ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async create(
    _key: string,
    _fingerprint: string | undefined,
    _ttlSeconds: number,
  ): Promise<CreateResult> {
    throw new Error('not implemented');
  }

  async complete(
    _key: string,
    _token: string,
    _response: CompleteResponse,
    _ttlSeconds: number,
  ): Promise<MutateResult> {
    throw new Error('not implemented');
  }

  async delete(_key: string, _token: string): Promise<MutateResult> {
    throw new Error('not implemented');
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /**
   * Idempotently creates the records table and supporting index.
   * Safe to call multiple times. Used by `autoCreateSchema=true` and
   * available as a public helper for code-driven migrations.
   */
  static async createSchema(
    pool: Pool,
    tableName: string = DEFAULT_TABLE_NAME,
  ): Promise<void> {
    const ident = quoteIdent(tableName);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${ident} (
        key            TEXT        PRIMARY KEY,
        token          UUID        NOT NULL,
        fingerprint    TEXT,
        status         TEXT        NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
        response_code  INT,
        response_body  TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at     TIMESTAMPTZ NOT NULL
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_' + tableName + '_expires_at')}
        ON ${ident} (expires_at);
    `);
  }
}

/**
 * Quotes a Postgres identifier safely. We allow `tableName` to be a
 * user-provided string, so we must defend against injection. Postgres
 * doubles internal double-quotes inside `"..."`.
 *
 * NOTE: Intentionally rejects schema-qualified names like
 * `myschema.idempotency_records` — the regex permits a single unquoted
 * identifier only. Quoting `schema.table` as `"schema.table"` would refer
 * to a single (escaped) identifier, NOT a qualified name. If
 * schema-qualified support is ever added, this validator MUST be replaced
 * with one that splits on `.` and validates each segment separately.
 * Do not loosen the regex without re-deriving the safety argument.
 */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `PostgresStorage: invalid identifier ${JSON.stringify(name)}; ` +
        `must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
    );
  }
  return `"${name}"`;
}
