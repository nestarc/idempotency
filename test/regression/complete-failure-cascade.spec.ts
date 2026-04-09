/**
 * Regression test for v0.1.3 — complete() failure cascade.
 *
 * Pre-v0.1.3 bug: if the handler succeeded but `storage.complete()` threw
 * (e.g. transient Redis network drop), the interceptor's outer catchError
 * treated the storage error like a handler error, deleted the PROCESSING
 * record, and rethrew. The client saw a 5xx and retried; retries found
 * no record and re-executed the business operation.
 *
 * Fix (v0.1.3): `captureResponse` is now total — a `storage.complete()`
 * exception is caught locally, logged at ERROR level, and the handler's
 * value is emitted to the client. The PROCESSING record stays in place
 * until TTL reclaims it, so a retry in that window correctly gets 409
 * instead of duplicate execution.
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

const decoratedHandler = () => {
  const handler = function h() {
    return undefined;
  };
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  return handler;
};

describe('REPRO: complete() failure cascade', () => {
  it('emits the handler value and does NOT delete the record when storage.complete() throws', async () => {
    const storage = new FakeStorage();
    // Simulate a transient storage write failure.
    storage.complete.mockImplementationOnce(async () => {
      throw new Error('redis write failed');
    });

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
    const handler = decoratedHandler();
    const { context } = buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': 'K-cascade' },
        body: {},
      },
      handler,
    });
    const handlerResult = { ok: true, id: 'business-op' };
    const next = buildCallHandler(of(handlerResult));

    // Desired behavior: the caller gets the handler's response, and the
    // record is NOT deleted (so a retry with the same key sees PROCESSING
    // and gets 409 instead of re-executing the handler).
    const result = await firstValueFrom(
      interceptor.intercept(context, next),
    );
    expect(result).toEqual(handlerResult);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
