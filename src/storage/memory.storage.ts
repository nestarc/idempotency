import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  CompleteResponse,
  CreateResult,
  IdempotencyStorage,
  MutateResult,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';

interface Entry {
  record: IdempotencyRecord;
  timer: NodeJS.Timeout;
}

/**
 * In-memory implementation of {@link IdempotencyStorage}.
 *
 * Backed by a `Map` with per-entry `setTimeout` expirations. Suitable for
 * tests and single-instance development. **Not safe for production**: state
 * is lost on restart and not shared across processes — two replicas would
 * each enforce idempotency independently, letting duplicates slip through.
 */
@Injectable()
export class MemoryStorage implements IdempotencyStorage, OnModuleDestroy {
  private readonly entries = new Map<string, Entry>();

  async get(key: string): Promise<IdempotencyRecord | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    // Safety net: if a timer hasn't fired yet for an expired record, evict on read.
    if (entry.record.expiresAt.getTime() <= Date.now()) {
      this.evict(key);
      return null;
    }
    return entry.record;
  }

  async create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<CreateResult> {
    if (this.entries.has(key)) {
      return { acquired: false };
    }
    const now = new Date();
    const token = randomUUID();
    const record: IdempotencyRecord = {
      key,
      token,
      fingerprint,
      status: 'PROCESSING',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
    this.entries.set(key, {
      record,
      timer: this.scheduleEviction(key, ttlSeconds),
    });
    return { acquired: true, token };
  }

  async complete(
    key: string,
    token: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<MutateResult> {
    const entry = this.entries.get(key);
    // Missing record: the original was evicted (or never existed). This is
    // the TTL-race case — the caller's token points at a record that no
    // longer exists. Signal stale so the caller knows not to retry.
    if (!entry) {
      return 'stale';
    }
    // Token mismatch: a newer caller has replaced our record. Silently refuse
    // to clobber their state.
    if (entry.record.token !== token) {
      return 'stale';
    }

    clearTimeout(entry.timer);
    const now = new Date();
    const updated: IdempotencyRecord = {
      ...entry.record,
      status: 'COMPLETED',
      statusCode: response.statusCode,
      responseBody: response.body,
      responseHeaders: response.headers ? { ...response.headers } : undefined,
      // `createdAt` is INTENTIONALLY preserved — it is an invariant field
      // of IdempotencyRecord (see interface docstring). Only `expiresAt`
      // is refreshed to the new TTL window.
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
    this.entries.set(key, {
      record: updated,
      timer: this.scheduleEviction(key, ttlSeconds),
    });
    return 'ok';
  }

  async delete(key: string, token: string): Promise<MutateResult> {
    const entry = this.entries.get(key);
    if (!entry) {
      // Idempotent cleanup: nothing to delete is success.
      return 'ok';
    }
    if (entry.record.token !== token) {
      return 'stale';
    }
    this.evict(key);
    return 'ok';
  }

  /**
   * Lifecycle hook: clear all pending eviction timers when the module is torn down.
   * Prevents leaked timers from keeping the Node event loop alive in long test runs.
   */
  async onModuleDestroy(): Promise<void> {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  private scheduleEviction(key: string, ttlSeconds: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.entries.delete(key);
    }, ttlSeconds * 1000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  }
}
