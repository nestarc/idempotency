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
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';

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
  return { interceptor: new IdempotencyInterceptor(new Reflector(), storage, options), storage };
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
      const { interceptor, storage } = buildInterceptor(ttl);
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

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toThrow(
        /ttl must be a positive integer/i,
      );
      expect(storage.ledger).toEqual([]);
      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    it(`rejects ${name} (${ttl}) TTL at the decorator level`, async () => {
      const { interceptor, storage } = buildInterceptor(60); // valid at module level
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

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toThrow(
        /ttl must be a positive integer/i,
      );
      expect(storage.ledger).toEqual([]);
      expect(next.handleSpy).not.toHaveBeenCalled();
    });
  }

  it('accepts a valid positive-integer TTL', async () => {
    const { interceptor, storage } = buildInterceptor(60);
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

    await expect(firstValueFrom(interceptor.intercept(context, next))).resolves.toEqual({
      ok: true,
    });
    expect(next.handleSpy).toHaveBeenCalledTimes(1);
    expect(storage.create).toHaveBeenCalledTimes(1);
    expect(storage.complete).toHaveBeenCalledTimes(1);
  });
});

describe('S6: portable TTL range at the interceptor boundary', () => {
  describe.each(['ttl', 'processingTtl'] as const)('%s', (option) => {
    describe.each(['module', 'decorator'] as const)('%s option', (level) => {
      it.each([2_147_483_648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '60'])(
        'rejects %s before storage or business execution',
        async (value) => {
          const storage = new FakeStorage();
          const setting = { [option]: value };
          const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
            storage,
            ...(level === 'module' ? setting : {}),
          } as IdempotencyOptions);
          const handler = decoratedHandler();
          if (level === 'decorator') {
            Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true, ...setting }, handler);
          }
          const { context } = buildExecutionContext({
            req: { method: 'POST', headers: { 'idempotency-key': 'invalid-range' }, body: {} },
            handler,
          });
          const next = buildCallHandler(of({ ok: true }));

          await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toThrow(
            RangeError,
          );
          expect(storage.ledger).toEqual([]);
          expect(next.handle).not.toHaveBeenCalled();
        },
      );
    });
  });

  it.each([1, 30 * 24 * 60 * 60, 2_147_483_647])(
    'passes the accepted TTL %s unchanged for both processing and completion',
    async (ttl) => {
      const storage = new FakeStorage();
      const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
        storage,
        ttl,
        processingTtl: ttl,
      });
      const { context } = buildExecutionContext({
        req: { method: 'POST', headers: { 'idempotency-key': 'valid-range' }, body: {} },
        handler: decoratedHandler(),
      });
      await expect(
        firstValueFrom(interceptor.intercept(context, buildCallHandler(of({ ok: true })))),
      ).resolves.toEqual({ ok: true });
      expect(storage.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), ttl);
      expect(storage.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        ttl,
      );
    },
  );
});
