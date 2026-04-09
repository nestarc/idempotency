/**
 * Regression test for v0.1.3 — get→create race with COMPLETED winner.
 *
 * Pre-v0.1.3 bug: when two requests raced past the initial `get()` (both
 * saw null) and the WINNER's full cycle (create → handler → complete)
 * finished before the loser's `create()` call, the loser's `create()`
 * returned `acquired: false` and the interceptor threw a spurious 409 —
 * even though the correct response was a replay of the winner's COMPLETED
 * record (or a 422 if fingerprints differed).
 *
 * Fix (v0.1.3): when `create()` returns `acquired: false`, the interceptor
 * re-reads the record with `storage.get()` and dispatches to
 * `handleExistingRecord`, giving the loser the same dispatch paths
 * (replay / 409 / 422) as if it had seen the record on the initial read.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import type { IdempotencyOptions } from '../../src/interfaces/idempotency-options.interface';
import type { IdempotencyRecord } from '../../src/interfaces/idempotency-record.interface';
import { FakeStorage } from '../support/fake-storage';
import {
  buildCallHandler,
  buildExecutionContext,
  buildResponse,
} from '../support/execution-context.factory';
import { createHash } from 'crypto';

const sha256 = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');

const decoratedHandler = () => {
  const handler = function h() {
    return undefined;
  };
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  return handler;
};

describe('REGRESSION: get→create race dispatch', () => {
  it('REPLAYS the racing winner when both requests share a fingerprint (COMPLETED)', async () => {
    const storage = new FakeStorage();
    const options: IdempotencyOptions = {
      storage,
      ttl: 60,
      headerName: 'Idempotency-Key',
      fingerprint: true,
      scope: 'global',
    };
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      storage,
      options,
    );

    // Stage the race: get() returns null (A's perspective), then between
    // A's get() and A's create(), B's COMPLETED record lands in storage.
    storage.get.mockResolvedValueOnce(null); // A's initial get
    storage.create.mockResolvedValueOnce({ acquired: false });
    // A's subsequent re-read (expected after acquired=false) should see
    // B's completed record with matching fingerprint.
    const completedRecord: IdempotencyRecord = {
      key: 'K-race',
      token: 'B-token',
      fingerprint: sha256({ amount: 100 }),
      status: 'COMPLETED',
      statusCode: 201,
      responseBody: '{"id":"from-B"}',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    storage.get.mockResolvedValueOnce(completedRecord);

    const handler = decoratedHandler();
    const res = buildResponse(200);
    const { context } = buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': 'K-race' },
        body: { amount: 100 },
      },
      res,
      handler,
    });
    const next = buildCallHandler(of({ shouldNotRun: true }));

    const result = await firstValueFrom(
      interceptor.intercept(context, next),
    );

    // A should receive B's replayed response, not a 409.
    expect(result).toEqual({ id: 'from-B' });
    expect(res.status).toHaveBeenCalledWith(201);
    // A's handler must NOT have been called.
    expect(next.handleSpy).not.toHaveBeenCalled();
  });

  it('returns 422 when the race winner is COMPLETED with a different fingerprint', async () => {
    const storage = new FakeStorage();
    const options: IdempotencyOptions = {
      storage,
      ttl: 60,
      headerName: 'Idempotency-Key',
      fingerprint: true,
      scope: 'global',
    };
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      storage,
      options,
    );

    storage.get.mockResolvedValueOnce(null);
    storage.create.mockResolvedValueOnce({ acquired: false });
    const racedRecord: IdempotencyRecord = {
      key: 'K-race',
      token: 'B-token',
      fingerprint: sha256({ amount: 100 }), // B's body
      status: 'COMPLETED',
      statusCode: 201,
      responseBody: '{"id":"from-B"}',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    storage.get.mockResolvedValueOnce(racedRecord);

    const handler = decoratedHandler();
    const { context } = buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': 'K-race' },
        body: { amount: 999 }, // A's DIFFERENT body
      },
      handler,
    });
    const next = buildCallHandler(of({ shouldNotRun: true }));

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).rejects.toMatchObject({
      status: 422,
    });
  });

  it('returns 409 when the race winner is still PROCESSING', async () => {
    const storage = new FakeStorage();
    const options: IdempotencyOptions = {
      storage,
      ttl: 60,
      headerName: 'Idempotency-Key',
      fingerprint: true,
      scope: 'global',
    };
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      storage,
      options,
    );

    storage.get.mockResolvedValueOnce(null);
    storage.create.mockResolvedValueOnce({ acquired: false });
    const processingRecord: IdempotencyRecord = {
      key: 'K-race',
      token: 'B-token',
      fingerprint: sha256({ amount: 100 }),
      status: 'PROCESSING',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    storage.get.mockResolvedValueOnce(processingRecord);

    const handler = decoratedHandler();
    const { context } = buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': 'K-race' },
        body: { amount: 100 },
      },
      handler,
    });
    const next = buildCallHandler(of({ shouldNotRun: true }));

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('falls back to 409 if the record vanishes between create() and the re-read', async () => {
    // Defensive edge case: impossible in normal operation but we guard against it.
    const storage = new FakeStorage();
    const options: IdempotencyOptions = {
      storage,
      ttl: 60,
      headerName: 'Idempotency-Key',
      fingerprint: true,
      scope: 'global',
    };
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      storage,
      options,
    );

    storage.get.mockResolvedValueOnce(null);
    storage.create.mockResolvedValueOnce({ acquired: false });
    storage.get.mockResolvedValueOnce(null); // vanished

    const handler = decoratedHandler();
    const { context } = buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': 'K-race' },
        body: {},
      },
      handler,
    });
    const next = buildCallHandler(of({ shouldNotRun: true }));

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});
