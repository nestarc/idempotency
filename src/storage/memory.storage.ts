import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type {
  CompleteResponse,
  IdempotencyStorage,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';

interface Entry {
  record: IdempotencyRecord;
  timer: NodeJS.Timeout;
}

/**
 * In-memory implementation of {@link IdempotencyStorage}.
 *
 * Backed by a `Map` and `setTimeout` for expirations. Suitable for tests and
 * single-instance development. **Not safe for production**: state is lost on
 * restart and not shared across processes — so two replicas would each enforce
 * idempotency independently and a duplicate could slip through.
 */
@Injectable()
export class MemoryStorage implements IdempotencyStorage, OnModuleDestroy {
  private readonly entries = new Map<string, Entry>();

  async get(key: string): Promise<IdempotencyRecord | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    // Safety net: if a timer somehow hasn't fired yet for an expired record,
    // evict on read.
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
  ): Promise<boolean> {
    if (this.entries.has(key)) {
      return false;
    }
    const now = new Date();
    const record: IdempotencyRecord = {
      key,
      fingerprint,
      status: 'PROCESSING',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
    this.entries.set(key, {
      record,
      timer: this.scheduleEviction(key, ttlSeconds),
    });
    return true;
  }

  async complete(
    key: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(
        `MemoryStorage.complete: record for key "${key}" does not exist`,
      );
    }
    clearTimeout(entry.timer);

    const now = new Date();
    const updated: IdempotencyRecord = {
      ...entry.record,
      status: 'COMPLETED',
      statusCode: response.statusCode,
      responseBody: response.body,
      // createdAt is preserved from the original PROCESSING record.
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
    // Refresh createdAt to "now" so that callers querying lifetime
    // (expiresAt - createdAt) see the new TTL window.
    updated.createdAt = now;
    this.entries.set(key, {
      record: updated,
      timer: this.scheduleEviction(key, ttlSeconds),
    });
  }

  async delete(key: string): Promise<void> {
    this.evict(key);
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
    // Allow the Node process to exit even if records are still pending.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  }
}
