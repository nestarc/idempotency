import 'reflect-metadata';
import { ConflictException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import {
  defer,
  firstValueFrom,
  from,
  of,
  Subject,
  throwError,
  timeout,
  TimeoutError,
  VirtualTimeScheduler,
} from 'rxjs';

import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import type { IdempotencyEvent } from '../../src/interfaces/idempotency-options.interface';
import type {
  CreateResult,
  MutateResult,
} from '../../src/interfaces/idempotency-storage.interface';
import { MemoryStorage } from '../../src/storage/memory.storage';
import { createRequestKey } from '../../src/utils/request-key';
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';

/** Controlled promises make operation order explicit without elapsed-time races. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('S5 failure and subscription lifecycle', () => {
  const storages: MemoryStorage[] = [];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await Promise.all(storages.splice(0).map((storage) => storage.onModuleDestroy()));
    jest.restoreAllMocks();
  });

  function fixture() {
    const storage = new MemoryStorage();
    storages.push(storage);
    const create = jest.spyOn(storage, 'create');
    const complete = jest.spyOn(storage, 'complete');
    const remove = jest.spyOn(storage, 'delete');
    const events: IdempotencyEvent[] = [];
    const rawKey = 'private-order-id';
    const scopedKey = createRequestKey(['global'], rawKey);
    const eventIdentity = {
      namespace: scopedKey.namespace,
      keyHash: createHash('sha256').update(scopedKey.key).digest('hex'),
    };
    const handler = () => undefined;
    Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
    const context = () =>
      buildExecutionContext({
        handler,
        req: {
          method: 'POST',
          headers: { 'idempotency-key': rawKey },
          body: { order: 'private-order' },
        },
      }).context;
    const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
      storage,
      ttl: 60,
      processingTtl: 30,
      scope: 'global',
      observability: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });
    const retryConflict = async () => {
      const retry = buildCallHandler(of({ duplicate: true }));
      await expect(firstValueFrom(interceptor.intercept(context(), retry))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(retry.handleSpy).not.toHaveBeenCalled();
    };
    return {
      storage,
      create,
      complete,
      remove,
      events,
      eventIdentity,
      key: scopedKey.key,
      context,
      interceptor,
      retryConflict,
    };
  }

  it.each(['synchronous throw', 'promise rejection'] as const)(
    'preserves successful work and the original lease after complete %s',
    async (failure) => {
      const f = fixture();
      const storageFailure = new Error('private storage credentials');
      f.complete.mockImplementationOnce(() => {
        if (failure === 'synchronous throw') throw storageFailure;
        return Promise.reject(storageFailure);
      });
      const started = deferred<void>();
      const result = deferred<{ charged: boolean }>();
      const next = buildCallHandler(
        defer(() => {
          started.resolve();
          return from(result.promise);
        }),
      );
      const request = firstValueFrom(f.interceptor.intercept(f.context(), next));
      await started.promise;
      const lock = await f.storage.get(f.key);
      expect(lock?.status).toBe('PROCESSING');
      result.resolve({ charged: true });

      await expect(request).resolves.toEqual({ charged: true });
      expect(await f.storage.get(f.key)).toEqual(lock);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.complete).toHaveBeenCalledTimes(1);
      expect(f.events).toEqual([
        {
          outcome: 'complete_error',
          ...f.eventIdentity,
          statusCode: 200,
          error: { code: 'storage_failure', operation: 'complete' },
        },
      ]);

      await f.retryConflict();
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
      expect(f.events[1]).toEqual({
        outcome: 'conflict',
        ...f.eventIdentity,
        statusCode: 409,
      });
    },
  );

  it('replays an applied completion when only its acknowledgement was lost', async () => {
    const f = fixture();
    f.complete.mockImplementationOnce(async (...args) => {
      await MemoryStorage.prototype.complete.apply(f.storage, args);
      throw new Error('completion acknowledgement lost');
    });
    const result = { charged: true };
    const first = buildCallHandler(of(result));
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), first))).resolves.toEqual(
      result,
    );
    const record = await f.storage.get(f.key);
    expect(record?.status).toBe('COMPLETED');
    expect(f.remove).not.toHaveBeenCalled();

    const retry = buildCallHandler(of({ duplicate: true }));
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), retry))).resolves.toEqual(
      result,
    );
    expect(retry.handleSpy).not.toHaveBeenCalled();
    expect(await f.storage.get(f.key)).toEqual(record);
    expect(f.events).toEqual([
      {
        outcome: 'complete_error',
        ...f.eventIdentity,
        statusCode: 200,
        error: { code: 'storage_failure', operation: 'complete' },
      },
      { outcome: 'replayed', ...f.eventIdentity, statusCode: 200 },
    ]);
  });

  it.each(['synchronous throw', 'promise rejection'] as const)(
    'preserves the handler error and lease after cleanup %s',
    async (failure) => {
      const f = fixture();
      const original = new Error('original business failure');
      const cleanupFailure = new Error('private delete credentials');
      f.remove.mockImplementationOnce(() => {
        if (failure === 'synchronous throw') throw cleanupFailure;
        return Promise.reject(cleanupFailure);
      });
      const next = buildCallHandler(throwError(() => original));
      await expect(firstValueFrom(f.interceptor.intercept(f.context(), next))).rejects.toBe(
        original,
      );
      const lock = await f.storage.get(f.key);
      expect(lock?.status).toBe('PROCESSING');
      expect(f.remove).toHaveBeenCalledTimes(1);
      expect(f.remove).toHaveBeenCalledWith(f.key, lock?.token);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.events).toEqual([
        {
          outcome: 'storage_error',
          ...f.eventIdentity,
          error: { code: 'storage_failure', operation: 'delete' },
        },
      ]);
      await f.retryConflict();
      expect(await f.storage.get(f.key)).toEqual(lock);
    },
  );

  it.each([
    ['unsubscribe', 'success'],
    ['unsubscribe', 'failure'],
    ['outer timeout', 'success'],
    ['outer timeout', 'failure'],
  ] as const)(
    '%s preserves PROCESSING when the underlying business promise later reports %s',
    async (cancellation, outcome) => {
      const f = fixture();
      const started = deferred<void>();
      const work = deferred<{ charged: boolean }>();
      const businessLedger: string[] = [];
      const business = work.promise.then(
        (value) => {
          businessLedger.push('committed');
          return value;
        },
        (error: unknown) => {
          businessLedger.push('failed');
          throw error;
        },
      );
      const next = buildCallHandler(
        defer(() => {
          started.resolve();
          return from(business);
        }),
      );
      const scheduler = new VirtualTimeScheduler();
      const source = f.interceptor.intercept(f.context(), next);
      const observer = { next: jest.fn(), error: jest.fn(), complete: jest.fn() };
      const subscription = (
        cancellation === 'outer timeout' ? source.pipe(timeout({ first: 1, scheduler })) : source
      ).subscribe(observer);
      await started.promise;
      const lock = await f.storage.get(f.key);
      expect(lock?.status).toBe('PROCESSING');

      if (cancellation === 'outer timeout') {
        scheduler.flush();
        expect(observer.error).toHaveBeenCalledTimes(1);
        expect(observer.error.mock.calls[0][0]).toBeInstanceOf(TimeoutError);
      } else {
        subscription.unsubscribe();
        expect(observer.error).not.toHaveBeenCalled();
      }
      expect(subscription.closed).toBe(true);
      if (outcome === 'success') {
        work.resolve({ charged: true });
        await expect(business).resolves.toEqual({ charged: true });
        expect(businessLedger).toEqual(['committed']);
      } else {
        const error = new Error('late business failure');
        work.reject(error);
        await expect(business).rejects.toBe(error);
        expect(businessLedger).toEqual(['failed']);
      }

      expect(await f.storage.get(f.key)).toEqual(lock);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
      expect(observer.next).not.toHaveBeenCalled();
      expect(observer.complete).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
      await f.retryConflict();
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
      expect(f.events).toEqual([
        {
          outcome: 'conflict',
          ...f.eventIdentity,
          statusCode: 409,
        },
      ]);
    },
  );

  it('retains PROCESSING for a result emitted without completion, including after cancellation', async () => {
    const f = fixture();
    const started = deferred<void>();
    const work = new Subject<unknown>();
    const next = buildCallHandler(
      defer(() => {
        started.resolve();
        return work;
      }),
    );
    const observer = { next: jest.fn(), error: jest.fn(), complete: jest.fn() };
    const subscription = f.interceptor.intercept(f.context(), next).subscribe(observer);
    await started.promise;
    const lock = await f.storage.get(f.key);
    work.next({ provisional: true });
    expect(observer.next).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    await f.retryConflict();
    subscription.unsubscribe();
    expect(await f.storage.get(f.key)).toEqual(lock);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.events.map((event) => event.outcome)).toEqual(['conflict']);
  });

  it('retains an applied create when cancelled before its acknowledgement and never starts the handler', async () => {
    const f = fixture();
    const created = deferred<void>();
    const acknowledge = deferred<void>();
    let pendingCreate!: Promise<CreateResult>;
    f.create.mockImplementationOnce((...args) => {
      pendingCreate = (async () => {
        const result = await MemoryStorage.prototype.create.apply(f.storage, args);
        created.resolve();
        await acknowledge.promise;
        return result;
      })();
      return pendingCreate;
    });
    const next = buildCallHandler(of({ charged: true }));
    const observer = { next: jest.fn(), error: jest.fn(), complete: jest.fn() };
    const subscription = f.interceptor.intercept(f.context(), next).subscribe(observer);
    await created.promise;
    const lock = await f.storage.get(f.key);
    expect(lock?.status).toBe('PROCESSING');
    subscription.unsubscribe();
    acknowledge.resolve();
    await pendingCreate;

    expect(await f.storage.get(f.key)).toEqual(lock);
    expect(next.handleSpy).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).not.toHaveBeenCalled();
    expect(observer.complete).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    await f.retryConflict();
  });

  it('allows an already-started complete promise to persist after cancellation and replays it on retry', async () => {
    const f = fixture();
    const completing = deferred<void>();
    const apply = deferred<void>();
    let pendingComplete!: Promise<MutateResult>;
    f.complete.mockImplementationOnce((...args) => {
      pendingComplete = apply.promise.then(() =>
        MemoryStorage.prototype.complete.apply(f.storage, args),
      );
      completing.resolve();
      return pendingComplete;
    });
    const result = { charged: true };
    const next = buildCallHandler(of(result));
    const observer = { next: jest.fn(), error: jest.fn(), complete: jest.fn() };
    const subscription = f.interceptor.intercept(f.context(), next).subscribe(observer);
    await completing.promise;
    expect((await f.storage.get(f.key))?.status).toBe('PROCESSING');
    subscription.unsubscribe();
    apply.resolve();
    await expect(pendingComplete).resolves.toBe('ok');

    expect((await f.storage.get(f.key))?.status).toBe('COMPLETED');
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).not.toHaveBeenCalled();
    expect(observer.complete).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    // Detached promise settlement has no subscriber to emit a created event.
    expect(f.events).toEqual([]);
    const retry = buildCallHandler(of({ duplicate: true }));
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), retry))).resolves.toEqual(
      result,
    );
    expect(retry.handleSpy).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      {
        outcome: 'replayed',
        ...f.eventIdentity,
        statusCode: 200,
      },
    ]);
  });

  it('allows an already-started cleanup promise to delete after cancellation and a retry to execute', async () => {
    const f = fixture();
    const deleting = deferred<void>();
    const apply = deferred<void>();
    let pendingDelete!: Promise<MutateResult>;
    f.remove.mockImplementationOnce((...args) => {
      pendingDelete = apply.promise.then(() =>
        MemoryStorage.prototype.delete.apply(f.storage, args),
      );
      deleting.resolve();
      return pendingDelete;
    });
    const original = new Error('handler failure');
    const next = buildCallHandler(throwError(() => original));
    const observer = { next: jest.fn(), error: jest.fn(), complete: jest.fn() };
    const subscription = f.interceptor.intercept(f.context(), next).subscribe(observer);
    await deleting.promise;
    expect((await f.storage.get(f.key))?.status).toBe('PROCESSING');
    subscription.unsubscribe();
    apply.resolve();
    await expect(pendingDelete).resolves.toBe('ok');

    expect(await f.storage.get(f.key)).toBeNull();
    expect(observer.error).not.toHaveBeenCalled();
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.complete).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    const retry = buildCallHandler(of({ retried: true }));
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), retry))).resolves.toEqual({
      retried: true,
    });
    expect(retry.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout inside the handler as a handler error and cleanup cannot cancel underlying work', async () => {
    const f = fixture();
    const started = deferred<void>();
    const work = deferred<{ charged: boolean }>();
    const businessLedger: string[] = [];
    const business = work.promise.then((result) => {
      businessLedger.push('committed');
      return result;
    });
    const scheduler = new VirtualTimeScheduler();
    const next = buildCallHandler(
      defer(() => {
        started.resolve();
        return from(business).pipe(timeout({ first: 1, scheduler }));
      }),
    );
    const request = firstValueFrom(f.interceptor.intercept(f.context(), next));
    await started.promise;
    const lock = await f.storage.get(f.key);
    scheduler.flush();
    await expect(request).rejects.toBeInstanceOf(TimeoutError);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledWith(f.key, lock?.token);
    expect(await f.storage.get(f.key)).toBeNull();
    expect(f.events).toEqual([]);

    work.resolve({ charged: true });
    await business;
    expect(businessLedger).toEqual(['committed']);
    expect(f.complete).not.toHaveBeenCalled();
    const retry = buildCallHandler(
      defer(() => {
        businessLedger.push('committed again');
        return of({ charged: true });
      }),
    );
    await firstValueFrom(f.interceptor.intercept(f.context(), retry));
    expect(businessLedger).toEqual(['committed', 'committed again']);
    expect(retry.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up a synchronous next.handle throw and permits retry', async () => {
    const f = fixture();
    const original = new Error('synchronous handler failure');
    const next = {
      handle: jest.fn(() => {
        throw original;
      }),
    };
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), next))).rejects.toBe(original);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(await f.storage.get(f.key)).toBeNull();
    expect(f.events).toEqual([]);
    const retry = buildCallHandler(of({ retried: true }));
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), retry))).resolves.toEqual({
      retried: true,
    });
    expect(retry.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes after a post-effect handler failure, documenting why retry can repeat a committed effect', async () => {
    const f = fixture();
    const businessLedger: string[] = [];
    const original = new Error('failure after commit');
    const next = buildCallHandler(
      defer(() => {
        businessLedger.push('committed');
        return throwError(() => original);
      }),
    );
    await expect(firstValueFrom(f.interceptor.intercept(f.context(), next))).rejects.toBe(original);
    expect(businessLedger).toEqual(['committed']);
    expect(await f.storage.get(f.key)).toBeNull();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    const retry = buildCallHandler(
      defer(() => {
        businessLedger.push('committed again');
        return of({ charged: true });
      }),
    );
    await firstValueFrom(f.interceptor.intercept(f.context(), retry));
    expect(businessLedger).toEqual(['committed', 'committed again']);
  });

  it('preserves a replacement token when the old handler eventually fails', async () => {
    const f = fixture();
    const started = deferred<void>();
    const work = new Subject<unknown>();
    const next = buildCallHandler(
      defer(() => {
        started.resolve();
        return work;
      }),
    );
    const request = firstValueFrom(f.interceptor.intercept(f.context(), next));
    await started.promise;
    const old = await f.storage.get(f.key);
    expect(old?.status).toBe('PROCESSING');
    // Model a removed/replaced lease; expiry semantics are covered by S6.
    await MemoryStorage.prototype.delete.call(f.storage, f.key, old!.token);
    const replacement = await f.storage.create(f.key, old!.fingerprint, 30);
    expect(replacement.token).not.toBe(old!.token);
    const replacementRecord = await f.storage.get(f.key);
    const original = new Error('old handler failed');
    work.error(original);

    await expect(request).rejects.toBe(original);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledWith(f.key, old!.token);
    expect(await f.storage.get(f.key)).toEqual(replacementRecord);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    await f.retryConflict();
    expect(await f.storage.get(f.key)).toEqual(replacementRecord);
  });
});
