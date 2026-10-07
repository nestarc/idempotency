import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  CompleteResponse,
  CreateResult,
  IdempotencyStorage,
  MutateResult,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';
import { assertTtlSeconds } from '../utils/ttl';

interface Entry {
  record: IdempotencyRecord;
  timer?: NodeJS.Timeout;
}

// Larger delays overflow Node's signed 32-bit timer range and fire after 1ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
    return this.getLiveEntry(key)?.record ?? null;
  }

  async create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<CreateResult> {
    assertTtlSeconds(ttlSeconds, 'MemoryStorage.create: ttlSeconds');
    if (this.getLiveEntry(key)) {
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
    const entry: Entry = { record };
    this.entries.set(key, entry);
    this.scheduleEviction(key, entry);
    return { acquired: true, token };
  }

  async complete(
    key: string,
    token: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<MutateResult> {
    assertTtlSeconds(ttlSeconds, 'MemoryStorage.complete: ttlSeconds');
    const entry = this.getLiveEntry(key);
    // Missing record: the original was evicted (or never existed). This is
    // the TTL-race case — the caller's token points at a record that no
    // longer exists. Signal stale so the caller knows not to retry.
    if (!entry) {
      return 'stale';
    }
    // Token mismatch: a newer caller has replaced our record. Silently refuse
    // to clobber their state.
    if (entry.record.token !== token || entry.record.status !== 'PROCESSING') {
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
    const completedEntry: Entry = { record: updated };
    this.entries.set(key, completedEntry);
    this.scheduleEviction(key, completedEntry);
    return 'ok';
  }

  async delete(key: string, token: string): Promise<MutateResult> {
    const entry = this.getLiveEntry(key);
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

  private getLiveEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    // Timers are cleanup only. Every operation uses the same logical expiry,
    // including when the event loop has not run the eviction callback yet.
    if (entry && entry.record.expiresAt.getTime() <= Date.now()) {
      this.evict(key);
      return undefined;
    }
    return entry;
  }

  private scheduleEviction(key: string, entry: Entry): void {
    const remainingMs = entry.record.expiresAt.getTime() - Date.now();
    const timer = setTimeout(
      () => {
        // Completion replaces the entry while preserving its token. Entry
        // identity also protects that refreshed deadline from queued callbacks.
        if (this.entries.get(key) !== entry) {
          return;
        }
        if (entry.record.expiresAt.getTime() <= Date.now()) {
          this.evict(key);
          return;
        }
        // A long TTL or a backwards clock adjustment can outlive this chunk.
        // Always schedule against the original logical deadline.
        this.scheduleEviction(key, entry);
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, remainingMs)),
    );
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    entry.timer = timer;
  }
}
