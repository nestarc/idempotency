/**
 * S4 regression: replaying explicitly allowed status headers used to override
 * the current request's exposure policy, and scheduled sweep errors published
 * arbitrary Error fields. Deny stored status headers and log fixed diagnostics.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Pool } from 'pg';
import { firstValueFrom, of } from 'rxjs';
import { inspect } from 'util';

import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import type { ReplayHeadersOption } from '../../src/interfaces/idempotency-options.interface';
import { PostgresSweepService } from '../../src/services/postgres-sweep.service';
import { PostgresStorage } from '../../src/storage/postgres.storage';
import { encodeReplayBody } from '../../src/utils/replay-body';
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';
import { FakeStorage } from '../support/fake-storage';
import { globalRequestKey } from '../support/request-key';

describe('S4: status headers belong to the current request', () => {
  const replayPolicies: ReplayHeadersOption[] = [
    true,
    false,
    ['location', 'Idempotency-Status', 'IDEMPOTENCY-REPLAYED'],
  ];

  describe.each([false, true])('exposeStatusHeaders=%s', (exposeStatusHeaders) => {
    it.each(replayPolicies)(
      'filters historical headers under replayHeaders=%j',
      async (replayHeaders) => {
        const storage = new FakeStorage();
        const rawKey = 's4-header-policy-key';
        const key = globalRequestKey(rawKey);
        storage.seed({
          key,
          status: 'COMPLETED',
          statusCode: 201,
          responseBody: encodeReplayBody({ id: 'order-1' }),
          responseHeaders: {
            location: '/orders/order-1',
            'IDEMPOTENCY-Status': 'historical-created',
            'Idempotency-Replayed': 'historical-false',
          },
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        });
        const handler = () => undefined;
        Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
        const { context, res } = buildExecutionContext({
          req: {
            method: 'POST',
            headers: { 'idempotency-key': rawKey },
            body: {},
          },
          handler,
        });
        const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
          storage,
          fingerprint: false,
          scope: 'global',
          replayHeaders,
          observability: { exposeStatusHeaders },
        });
        const next = buildCallHandler(of('must not execute'));

        await expect(firstValueFrom(interceptor.intercept(context, next))).resolves.toEqual({
          id: 'order-1',
        });

        const expectedHeaders: Record<string, string> = {};
        if (replayHeaders !== false) expectedHeaders.location = '/orders/order-1';
        if (exposeStatusHeaders) {
          expectedHeaders['idempotency-status'] = 'replayed';
          expectedHeaders['idempotency-replayed'] = 'true';
        }
        expect(res.getHeaders()).toEqual(expectedHeaders);
        expect(inspect(res.setHeader.mock.calls)).not.toContain('historical-');
        expect(res.statusCode).toBe(201);
        expect(next.handleSpy).not.toHaveBeenCalled();
        expect(storage.create).not.toHaveBeenCalled();
        expect(storage.complete).not.toHaveBeenCalled();
        expect(storage.delete).not.toHaveBeenCalled();
        expect((await storage.get(key))?.status).toBe('COMPLETED');
      },
    );
  });
});

// Mock pool failures test the scheduled logging boundary, not a real DB outage.
describe('S4: scheduled sweep failure logging', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps sensitive message, stack, cause and custom fields out of every logger argument', async () => {
    const secret = 'S4-FAKE-SWEEP-SECRET-705934';
    const failure = Object.assign(new Error(`database unavailable ${secret}`), {
      cause: new Error(`connection string ${secret}`),
      key: secret,
    });
    const connect = jest.fn().mockRejectedValue(failure);
    const storage = new PostgresStorage({ pool: { connect } as unknown as Pool });
    const service = new PostgresSweepService(storage, { enabled: true, intervalMs: 10 });
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    try {
      await service.onModuleInit();
      await jest.advanceTimersByTimeAsync(10);

      expect(logger).toHaveBeenCalledTimes(1);
      expect(inspect(logger.mock.calls, { depth: null, showHidden: true })).not.toContain(secret);
      expect(logger).toHaveBeenCalledWith(expect.any(String), { code: 'sweep_failure' });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each(['throw', 'reject'])(
    'continues sweeping when the called Logger method can %s',
    async (mode) => {
      const client = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [{ acquired: true }] })
          .mockResolvedValueOnce({ rowCount: 1 })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn(),
      };
      const connect = jest
        .fn()
        .mockRejectedValueOnce(new Error('S4-FAKE-SWEEP-DB-SECRET'))
        .mockResolvedValue(client);
      const storage = new PostgresStorage({ pool: { connect } as unknown as Pool });
      const service = new PostgresSweepService(storage, { enabled: true, intervalMs: 10 });
      const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
        const error = new Error('S4-FAKE-LOGGER-SECRET');
        if (mode === 'throw') throw error;
        return Promise.reject(error);
      });

      try {
        await service.onModuleInit();
        await jest.advanceTimersByTimeAsync(20);

        expect(logger).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(client.query).toHaveBeenCalledTimes(3);
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(inspect(logger.mock.calls, { depth: null, showHidden: true })).not.toContain(
          'S4-FAKE-',
        );
      } finally {
        await service.onModuleDestroy();
      }
    },
  );
});
