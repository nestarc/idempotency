/**
 * Regression: a standard HTTP Observable has one response, determined when
 * its source completes successfully. Capturing every emission publishes an
 * intermediate response to retries even though the handler can still fail.
 *
 * Cache only the final value once; an empty successful source yields undefined.
 * Cancellation is not evidence that business work failed, so it must neither
 * complete the record nor automatically delete the processing lease.
 */
import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EMPTY, Observable, Subject, firstValueFrom, lastValueFrom, of } from 'rxjs';

import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { encodeReplayBody } from '../../src/utils/replay-body';
import { MemoryStorage } from '../../src/storage/memory.storage';
import { globalRequestKey } from '../support/request-key';
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';

const KEY = 'response-completion';
const STORAGE_KEY = globalRequestKey(KEY);

const activeStorages: MemoryStorage[] = [];

const buildHarness = () => {
  const storage = new MemoryStorage();
  activeStorages.push(storage);
  jest.spyOn(storage, 'complete');
  jest.spyOn(storage, 'delete');
  const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
    storage,
    ttl: 60,
    processingTtl: 30,
    scope: 'global',
  });
  const handler = () => undefined;
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  const context = () =>
    buildExecutionContext({
      req: {
        method: 'POST',
        headers: { 'idempotency-key': KEY },
        body: { operation: 'create-order' },
      },
      handler,
    }).context;
  return { storage, interceptor, context };
};

/** Wait for lock acquisition and actual source subscription without sleeps. */
const controlledHandler = () => {
  const source = new Subject<unknown>();
  let markSubscribed!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    markSubscribed = resolve;
  });
  const next = buildCallHandler(
    new Observable<unknown>((subscriber) => {
      const subscription = source.subscribe(subscriber);
      markSubscribed();
      return subscription;
    }),
  );
  return { source, subscribed, next };
};

describe('REGRESSION: HTTP response is captured on successful completion', () => {
  afterEach(async () => {
    await Promise.all(activeStorages.splice(0).map((storage) => storage.onModuleDestroy()));
  });

  it('publishes success only after the real storage completion becomes visible to retries', async () => {
    const { storage, interceptor, context } = buildHarness();
    const persist = MemoryStorage.prototype.complete.bind(storage);
    let markStarted!: () => void;
    let releaseCompletion!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    jest.spyOn(storage, 'complete').mockImplementationOnce(async (...args) => {
      markStarted();
      await released;
      return persist(...args);
    });
    const emissions: unknown[] = [];
    const original = { id: 'order-1' };
    const next = buildCallHandler(of(original));
    let resolveResponse!: () => void;
    let rejectResponse!: (error: unknown) => void;
    const response = new Promise<void>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const subscription = interceptor.intercept(context(), next).subscribe({
      next: (value) => emissions.push(value),
      error: rejectResponse,
      complete: resolveResponse,
    });

    try {
      await started;
      expect(emissions).toEqual([]);
      expect(await storage.get(STORAGE_KEY)).toMatchObject({ status: 'PROCESSING' });
      const inFlightRetry = buildCallHandler(of({ duplicate: true }));
      await expect(
        firstValueFrom(interceptor.intercept(context(), inFlightRetry)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inFlightRetry.handleSpy).not.toHaveBeenCalled();

      releaseCompletion();
      await response;
      expect(emissions).toEqual([original]);
      expect(await storage.get(STORAGE_KEY)).toMatchObject({ status: 'COMPLETED' });
      const completedRetry = buildCallHandler(of({ duplicate: true }));
      await expect(
        firstValueFrom(interceptor.intercept(context(), completedRetry)),
      ).resolves.toEqual(original);
      expect(completedRetry.handleSpy).not.toHaveBeenCalled();
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
      expect(storage.complete).toHaveBeenCalledTimes(1);
      expect(storage.delete).not.toHaveBeenCalled();
    } finally {
      releaseCompletion();
      subscription.unsubscribe();
    }
  });

  it('keeps intermediate values private and rejects retries while the source remains open', async () => {
    const { storage, interceptor, context } = buildHarness();
    const { source, subscribed, next } = controlledHandler();
    const emitted = jest.fn();
    const subscription = interceptor.intercept(context(), next).subscribe(emitted);

    try {
      await subscribed;
      source.next({ progress: 'payment-started' });

      expect(storage.complete).not.toHaveBeenCalled();
      expect(emitted).not.toHaveBeenCalled();
      expect(await storage.get(STORAGE_KEY)).toMatchObject({ status: 'PROCESSING' });

      const retry = buildCallHandler(of({ unexpected: 'duplicate-execution' }));
      await expect(firstValueFrom(interceptor.intercept(context(), retry))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(retry.handleSpy).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
      source.complete();
    }
  });

  it('captures only the last value once and replays it after successful source completion', async () => {
    const { storage, interceptor, context } = buildHarness();
    const { source, subscribed, next } = controlledHandler();
    const response = lastValueFrom(interceptor.intercept(context(), next));
    await subscribed;

    source.next({ progress: 'validated' });
    source.next({ progress: 'persisting' });
    const finalValue = { id: 'order-1', status: 'created' };
    source.next(finalValue);
    source.complete();

    await expect(response).resolves.toEqual(finalValue);
    expect(storage.complete).toHaveBeenCalledTimes(1);
    expect(storage.complete).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.any(String),
      expect.objectContaining({ statusCode: 200, body: encodeReplayBody(finalValue) }),
      60,
    );
    expect(storage.delete).not.toHaveBeenCalled();

    const retry = buildCallHandler(of({ unexpected: 'duplicate-execution' }));
    await expect(firstValueFrom(interceptor.intercept(context(), retry))).resolves.toEqual(
      finalValue,
    );
    expect(retry.handleSpy).not.toHaveBeenCalled();
    expect(storage.complete).toHaveBeenCalledTimes(1);
  });

  it('never caches an intermediate value when the source later errors', async () => {
    const { storage, interceptor, context } = buildHarness();
    const { source, subscribed, next } = controlledHandler();
    const failure = new Error('business operation failed before completion');
    const response = lastValueFrom(interceptor.intercept(context(), next));
    const rejected = expect(response).rejects.toBe(failure);
    await subscribed;

    source.next({ progress: 'started' });
    source.error(failure);

    await rejected;
    expect(storage.complete).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(await storage.get(STORAGE_KEY)).toBeNull();
  });

  it('treats EMPTY as one successful undefined response and can replay it', async () => {
    const { storage, interceptor, context } = buildHarness();
    const next = buildCallHandler(EMPTY);

    await expect(lastValueFrom(interceptor.intercept(context(), next))).resolves.toBeUndefined();
    expect(storage.complete).toHaveBeenCalledTimes(1);
    expect(storage.complete).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.any(String),
      expect.objectContaining({ statusCode: 200, body: encodeReplayBody(undefined) }),
      60,
    );
    expect(await storage.get(STORAGE_KEY)).toMatchObject({
      status: 'COMPLETED',
      responseBody: encodeReplayBody(undefined),
    });

    const retry = buildCallHandler(of({ unexpected: 'duplicate-execution' }));
    await expect(firstValueFrom(interceptor.intercept(context(), retry))).resolves.toBeUndefined();
    expect(retry.handleSpy).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'leaves the processing lease intact after cancellation (intermediate emission: %s)',
    async (emitBeforeCancellation) => {
      const { storage, interceptor, context } = buildHarness();
      const { source, subscribed, next } = controlledHandler();
      const emitted = jest.fn();
      const subscription = interceptor.intercept(context(), next).subscribe(emitted);
      await subscribed;

      if (emitBeforeCancellation) source.next({ progress: 'started' });
      subscription.unsubscribe();
      // Business work may still finish after the HTTP subscription is gone.
      source.next({ id: 'order-finished-after-cancellation' });
      source.complete();

      expect(emitted).not.toHaveBeenCalled();
      expect(storage.complete).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(await storage.get(STORAGE_KEY)).toMatchObject({ status: 'PROCESSING' });

      const retry = buildCallHandler(of({ unexpected: 'duplicate-execution' }));
      await expect(firstValueFrom(interceptor.intercept(context(), retry))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(retry.handleSpy).not.toHaveBeenCalled();
    },
  );
});
