/**
 * Regression test for v0.1.3 — TTL validation.
 *
 * Pre-v0.1.3 the interceptor accepted any numeric TTL, so 0, negatives,
 * and fractional values would reach the storage adapters — where their
 * behavior diverged (Redis `EX 0` is rejected; MemoryStorage would
 * schedule a timer with 0ms and evict immediately). Every developer
 * would have to learn which values are safe the hard way.
 *
 * Fix (v0.1.3): the interceptor's `resolveOptions()` validates that
 * `ttl` is a positive integer and throws a descriptive error otherwise.
 * Failure is surfaced at request time at the interceptor boundary with
 * the exact offending value in the message.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import type { IdempotencyOptions } from '../../src/interfaces/idempotency-options.interface';
import { FakeStorage } from '../support/fake-storage';
import {
  buildCallHandler,
  buildExecutionContext,
} from '../support/execution-context.factory';

const decoratedHandler = (ttl?: number) => {
  const handler = function h() {
    return undefined;
  };
  Reflect.defineMetadata(
    IDEMPOTENT_METADATA_KEY,
    { enabled: true, ...(ttl !== undefined ? { ttl } : {}) },
    handler,
  );
  return handler;
};

const buildInterceptor = (moduleTtl?: number) => {
  const storage = new FakeStorage();
  const options: IdempotencyOptions = {
    storage,
    headerName: 'Idempotency-Key',
    fingerprint: true,
    scope: 'global',
    ...(moduleTtl !== undefined ? { ttl: moduleTtl } : {}),
  };
  return new IdempotencyInterceptor(new Reflector(), storage, options);
};

describe('REGRESSION: TTL validation', () => {
  const invalidCases: Array<{ name: string; ttl: number | undefined }> = [
    { name: 'zero', ttl: 0 },
    { name: 'negative', ttl: -10 },
    { name: 'fractional', ttl: 1.5 },
    { name: 'NaN', ttl: Number.NaN },
    { name: 'Infinity', ttl: Number.POSITIVE_INFINITY },
  ];

  for (const { name, ttl } of invalidCases) {
    it(`rejects ${name} (${ttl}) TTL at the module level`, async () => {
      const interceptor = buildInterceptor(ttl);
      const handler = decoratedHandler();
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-ttl' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toThrow(/ttl must be a positive integer/i);
    });

    it(`rejects ${name} (${ttl}) TTL at the decorator level`, async () => {
      const interceptor = buildInterceptor(60); // valid at module level
      const handler = decoratedHandler(ttl);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-ttl' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toThrow(/ttl must be a positive integer/i);
    });
  }

  it('accepts a valid positive-integer TTL', async () => {
    const interceptor = buildInterceptor(60);
    const handler = decoratedHandler();
    const { context } = buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': 'K-valid-ttl' },
        body: {},
      },
      handler,
    });
    const next = buildCallHandler(of({ ok: true }));

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).resolves.toEqual({ ok: true });
  });
});
