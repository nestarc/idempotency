import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { IDEMPOTENCY_SWEEP_OPTIONS } from '../idempotency.constants';
import { PostgresStorage, quoteIdent } from '../storage/postgres.storage';

export interface SweepOptions {
  /** When false, the service is wired up but never schedules a sweep. */
  enabled: boolean;
  /** Sweep cadence. Defaults to 60_000 (1 minute). */
  intervalMs?: number;
}

const SWEEP_LOCK_KEY = 'idempotency-sweep';

/**
 * Optional service that periodically deletes expired idempotency records.
 *
 * Lazy expiration in {@link PostgresStorage.get} already guarantees
 * correctness; this service exists only to keep disk usage and dead
 * tuples bounded in long-running deployments.
 *
 * Multi-instance safety: each sweep wraps DELETE in
 * `pg_try_advisory_lock(hashtext('idempotency-sweep'))`. Concurrent
 * replicas will see a lock contention and skip — no DELETE storms.
 */
@Injectable()
export class PostgresSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresSweepService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly storage: PostgresStorage,
    @Optional()
    @Inject(IDEMPOTENCY_SWEEP_OPTIONS)
    private readonly options: SweepOptions = { enabled: false },
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.enabled) return;
    const interval = this.options.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`sweep failed: ${(err as Error).message}`, err as Error),
      );
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Runs one sweep cycle. Returns the number of rows deleted (0 if another
   * replica holds the advisory lock for this cycle).
   */
  async sweep(): Promise<{ deleted: number }> {
    const pool = this.storage.pool;
    const tableName = this.storage.tableName;
    const ident = quoteIdent(tableName);

    const client = await pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
        [SWEEP_LOCK_KEY],
      );
      if (!lock.rows[0].acquired) {
        return { deleted: 0 };
      }
      try {
        const del = await client.query(
          `DELETE FROM ${ident} WHERE expires_at < now()`,
        );
        return { deleted: del.rowCount ?? 0 };
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
          SWEEP_LOCK_KEY,
        ]);
      }
    } finally {
      client.release();
    }
  }
}
