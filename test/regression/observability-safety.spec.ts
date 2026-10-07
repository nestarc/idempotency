/**
 * S4 regression: inspect complete events and every Logger argument, including
 * non-enumerable Error fields. Hash-only checks missed raw error disclosure and
 * synchronous adapter throws previously bypassed storage-error observation.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { inspect } from 'util';
import { firstValueFrom, of, throwError } from 'rxjs';

import {
  IDEMPOTENT_METADATA_KEY,
  IdempotencyInterceptor,
  type IdempotencyEvent,
  type IdempotencyOptions,
  type IdempotencyRecord,
} from '../../src';
import { createRequestKey } from '../../src/utils/request-key';
import { encodeReplayBody } from '../../src/utils/replay-body';
import { stableJsonStringify } from '../../src/utils/stable-json';
import {
  buildCallHandler,
  buildExecutionContext,
  buildResponse,
} from '../support/execution-context.factory';
import { FakeStorage } from '../support/fake-storage';

const secrets = {
  rawKey: 'S4-FAKE-RAW-KEY-d8c7a920',
  body: 'S4-FAKE-REQUEST-BODY-a384edb1',
  response: 'S4-FAKE-RESPONSE-BODY-b219a6dc',
  identity: 'S4-FAKE-IDENTITY-9c6e3a57',
  path: 'S4-FAKE-PATH-4672da18',
  message: 'S4-FAKE-ERROR-MESSAGE-e5127c98',
  stack: 'S4-FAKE-ERROR-STACK-7e31b684',
  cause: 'S4-FAKE-ERROR-CAUSE-64172ac9',
  metadata: 'S4-FAKE-ERROR-METADATA-f41d9720',
  hidden: 'S4-FAKE-ERROR-HIDDEN-31db4072',
};
const requestPath = `/payments/${secrets.path}`;
const requestBody = { reference: secrets.body };
const handlerValue = { reference: secrets.response };
const requestKey = createRequestKey(
  ['endpoint', [secrets.identity], ['path', 'POST', requestPath]],
  secrets.rawKey,
);
const keyHash = createHash('sha256').update(requestKey.key).digest('hex');
const fingerprint = createHash('sha256').update(stableJsonStringify(requestBody)!).digest('hex');

type CallbackMode = 'none' | 'sync throw' | 'async reject';
type FailureMode = 'sync throw' | 'async reject';
type StorageOperation = 'get' | 'create' | 'race_get' | 'complete' | 'delete';
type OutcomeCase = 'created' | 'replayed' | 'conflict' | 'mismatch' | 'bypassed' | 'stale';

const privateError = () => {
  const error = new Error(`${secrets.message}: ${secrets.rawKey}`, {
    cause: new Error(`${secrets.cause}: ${secrets.rawKey}`),
  });
  error.stack = `${secrets.stack}: ${secrets.rawKey}`;
  Object.assign(error, { metadata: secrets.metadata, body: requestBody });
  Object.defineProperty(error, 'privateDetail', { value: secrets.hidden });
  return error;
};

const fail = (mode: FailureMode, error: unknown): (() => Promise<never>) =>
  mode === 'sync throw'
    ? () => {
        throw error;
      }
    : () => Promise.reject(error);

describe('REGRESSION: observability payload and failure isolation', () => {
  let events: IdempotencyEvent[];
  let loggerSpies: jest.SpyInstance[];

  beforeEach(() => {
    events = [];
    loggerSpies = (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
    );
  });

  afterEach(async () => {
    // Let rejected observer Promises and their catch handlers settle before
    // examining logs. Jest also fails if a rejection escapes unhandled.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observed = { events, loggerArguments: loggerSpies.flatMap((spy) => spy.mock.calls) };
    const json = JSON.stringify(observed);
    const completeInspection = inspect(observed, {
      depth: null,
      showHidden: true,
      getters: false,
      customInspect: false,
    });
    for (const secret of Object.values(secrets)) {
      expect(json).not.toContain(secret);
      expect(completeInspection).not.toContain(secret);
    }
    // Storage addresses are opaque, but telemetry has its own correlation
    // fields and should not accidentally publish the old event.scope value.
    expect(json).not.toContain(requestKey.key);
    expect(completeInspection).not.toContain(requestKey.key);
  });

  const prepare = (
    storage: FakeStorage,
    callbackMode: CallbackMode = 'none',
    exposeStatusHeaders = false,
    responseValue: unknown = handlerValue,
    handlerError?: Error,
    request: { rawKey?: string; identity?: string; path?: string } = {},
  ) => {
    const callbackError = privateError();
    const onEvent = jest.fn((event: IdempotencyEvent): void | Promise<void> => {
      events.push(event);
      if (callbackMode === 'sync throw') throw callbackError;
      if (callbackMode === 'async reject') return Promise.reject(callbackError);
    });
    const options: IdempotencyOptions = {
      storage,
      ttl: 60,
      scope: () => [request.identity ?? secrets.identity],
      observability: { onEvent, exposeStatusHeaders },
    };
    const handler = function execute() {};
    Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
    const { context, res } = buildExecutionContext({
      req: {
        method: 'POST',
        originalUrl: request.path ?? requestPath,
        headers: { 'idempotency-key': request.rawKey ?? secrets.rawKey },
        body: requestBody,
      },
      res: buildResponse(201, { 'content-type': 'application/json' }),
      handler,
    });
    const next = buildCallHandler(
      handlerError ? throwError(() => handlerError) : of(responseValue),
    );
    const interceptor = new IdempotencyInterceptor(new Reflector(), storage, options);
    return {
      next,
      res,
      onEvent,
      run: () => firstValueFrom(interceptor.intercept(context, next)),
    };
  };

  const seed = (storage: FakeStorage, overrides: Partial<IdempotencyRecord> = {}) => {
    const record: IdempotencyRecord = {
      key: requestKey.key,
      token: 'existing-token',
      fingerprint,
      status: 'PROCESSING',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
    storage.seed(record);
    return record;
  };

  const expectSingleEvent = (
    outcome: IdempotencyEvent['outcome'],
    details: Record<string, unknown> = {},
  ) => {
    expect(events).toEqual([{ outcome, keyHash, namespace: requestKey.namespace, ...details }]);
    expect(events[0]).not.toHaveProperty('scope');
    if (!('error' in details)) expect(events[0]).not.toHaveProperty('error');
  };

  describe.each<CallbackMode>(['none', 'sync throw', 'async reject'])(
    'observer: %s',
    (callbackMode) => {
      it.each<OutcomeCase>(['created', 'replayed', 'conflict', 'mismatch', 'bypassed', 'stale'])(
        'emits exactly one safe %s event and preserves the response/record with status headers disabled',
        async (outcome) => {
          const storage = new FakeStorage();
          let originalRecord: IdempotencyRecord | undefined;
          if (outcome === 'replayed') {
            originalRecord = seed(storage, {
              status: 'COMPLETED',
              statusCode: 202,
              responseBody: encodeReplayBody(handlerValue),
              responseHeaders: {
                'content-type': 'application/json',
                'idempotency-status': 'created',
              },
            });
          } else if (outcome === 'conflict' || outcome === 'mismatch') {
            originalRecord = seed(
              storage,
              outcome === 'mismatch' ? { fingerprint: 'different' } : {},
            );
          } else if (outcome === 'stale') {
            storage.complete.mockImplementationOnce(async () => {
              originalRecord = seed(storage, { token: 'replacement-token' });
              return 'stale';
            });
          }
          const value = outcome === 'bypassed' ? new Date() : handlerValue;
          const { run, next, res, onEvent } = prepare(storage, callbackMode, false, value);

          if (outcome === 'conflict' || outcome === 'mismatch') {
            const status = outcome === 'conflict' ? 409 : 422;
            await expect(run()).rejects.toMatchObject({ status });
            expectSingleEvent(outcome, { statusCode: status });
            expect(next.handleSpy).not.toHaveBeenCalled();
          } else {
            await expect(run()).resolves.toEqual(value);
            expectSingleEvent(outcome, {
              statusCode: outcome === 'replayed' ? 202 : 201,
              ...(outcome === 'bypassed' ? { error: { code: 'response_not_replayable' } } : {}),
            });
            expect(next.handleSpy).toHaveBeenCalledTimes(outcome === 'replayed' ? 0 : 1);
          }
          expect(onEvent).toHaveBeenCalledTimes(1);
          expect(res.getHeaders()).not.toHaveProperty('idempotency-status');
          expect(res.getHeaders()).not.toHaveProperty('idempotency-replayed');
          if (outcome === 'replayed') {
            expect(res.statusCode).toBe(202);
            expect(res.getHeaders()['content-type']).toBe('application/json');
          }
          expect(storage.delete).not.toHaveBeenCalled();
          if (originalRecord) {
            expect(await storage.get(requestKey.key)).toEqual(originalRecord);
          } else {
            expect(await storage.get(requestKey.key)).toMatchObject({
              status: outcome === 'created' ? 'COMPLETED' : 'PROCESSING',
            });
          }
        },
      );

      describe.each<FailureMode>(['sync throw', 'async reject'])('adapter: %s', (failureMode) => {
        it.each<StorageOperation>(['get', 'create', 'race_get', 'complete', 'delete'])(
          'observes %s failure once without changing the business result or cleanup state',
          async (operation) => {
            const storage = new FakeStorage();
            const storageError = privateError();
            const handlerError = privateError();
            const failure = fail(failureMode, storageError);
            let acquiredRecord: IdempotencyRecord | null = null;
            if (operation === 'race_get') {
              storage.get.mockResolvedValueOnce(null).mockImplementationOnce(failure);
              storage.create.mockResolvedValueOnce({ acquired: false });
            } else {
              storage[operation].mockImplementationOnce(failure);
            }
            if (operation === 'complete' || operation === 'delete') {
              const create = storage.create.getMockImplementation()!;
              storage.create.mockImplementationOnce(async (...args) => {
                const result = await create(...args);
                acquiredRecord = await storage.get(requestKey.key);
                return result;
              });
            }
            const { run, next, res, onEvent } = prepare(
              storage,
              callbackMode,
              false,
              handlerValue,
              operation === 'delete' ? handlerError : undefined,
            );

            if (operation === 'complete') {
              await expect(run()).resolves.toBe(handlerValue);
            } else {
              await expect(run()).rejects.toBe(
                operation === 'delete' ? handlerError : storageError,
              );
            }
            expectSingleEvent(operation === 'complete' ? 'complete_error' : 'storage_error', {
              ...(operation === 'complete' ? { statusCode: 201 } : {}),
              error: { code: 'storage_failure', operation },
            });
            expect(onEvent).toHaveBeenCalledTimes(1);
            expect(next.handleSpy).toHaveBeenCalledTimes(
              operation === 'complete' || operation === 'delete' ? 1 : 0,
            );
            expect(storage.delete).toHaveBeenCalledTimes(operation === 'delete' ? 1 : 0);
            expect(storage.complete).toHaveBeenCalledTimes(operation === 'complete' ? 1 : 0);
            expect(res.getHeaders()).not.toHaveProperty('idempotency-status');
            expect(res.getHeaders()).not.toHaveProperty('idempotency-replayed');
            if (operation === 'complete' || operation === 'delete') {
              expect(acquiredRecord).toMatchObject({ status: 'PROCESSING' });
              expect(await storage.get(requestKey.key)).toEqual(acquiredRecord);
            }
          },
        );
      });
    },
  );

  it.each<OutcomeCase>(['created', 'replayed', 'conflict', 'mismatch', 'bypassed', 'stale'])(
    'exposes the matching status header for %s without changing safe event fields',
    async (outcome) => {
      const storage = new FakeStorage();
      if (outcome === 'replayed') {
        seed(storage, {
          status: 'COMPLETED',
          statusCode: 201,
          responseBody: encodeReplayBody(handlerValue),
        });
      } else if (outcome === 'conflict' || outcome === 'mismatch') {
        seed(storage, outcome === 'mismatch' ? { fingerprint: 'different' } : {});
      } else if (outcome === 'stale') {
        storage.complete.mockResolvedValueOnce('stale');
      }
      const { run, res } = prepare(
        storage,
        'none',
        true,
        outcome === 'bypassed' ? new Date() : handlerValue,
      );
      if (outcome === 'conflict' || outcome === 'mismatch') {
        await expect(run()).rejects.toMatchObject({ status: outcome === 'conflict' ? 409 : 422 });
      } else {
        await run();
      }
      expect(res.getHeaders()['idempotency-status']).toBe(outcome);
      expect(res.getHeaders()['idempotency-replayed']).toBe(
        outcome === 'replayed' ? 'true' : undefined,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome, namespace: requestKey.namespace, keyHash });
    },
  );

  it('keeps an already-sent response untouched while observing bypass safely', async () => {
    const storage = new FakeStorage();
    const { run, res } = prepare(storage, 'async reject', true);
    Object.assign(res, { headersSent: true });

    await expect(run()).resolves.toBe(handlerValue);

    expectSingleEvent('bypassed', { statusCode: 201, error: { code: 'response_not_replayable' } });
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(storage.complete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await storage.get(requestKey.key)).toMatchObject({ status: 'PROCESSING' });
  });

  it('preserves the original handler failure after successful cleanup without reporting a storage failure', async () => {
    const storage = new FakeStorage();
    const handlerError = privateError();
    const { run, onEvent } = prepare(storage, 'async reject', false, handlerValue, handlerError);

    await expect(run()).rejects.toBe(handlerError);

    expect(onEvent).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(await storage.get(requestKey.key)).toBeNull();
  });

  it('correlates retries by keyHash and requests by namespace without exposing identity or path', async () => {
    const storage = new FakeStorage();
    const requests = [
      { rawKey: secrets.rawKey, identity: secrets.identity, path: requestPath },
      { rawKey: `${secrets.rawKey}-second`, identity: secrets.identity, path: requestPath },
      { rawKey: secrets.rawKey, identity: secrets.identity, path: requestPath },
      { rawKey: secrets.rawKey, identity: `${secrets.identity}-second`, path: requestPath },
      { rawKey: secrets.rawKey, identity: secrets.identity, path: `${requestPath}/second` },
    ];
    for (const request of requests) {
      await prepare(storage, 'none', false, handlerValue, undefined, request).run();
    }

    expect(events).toEqual(
      requests.map((request, index) => {
        const encoded = createRequestKey(
          ['endpoint', [request.identity], ['path', 'POST', request.path]],
          request.rawKey,
        );
        return {
          outcome: index === 2 ? 'replayed' : 'created',
          keyHash: createHash('sha256').update(encoded.key).digest('hex'),
          namespace: encoded.namespace,
          statusCode: 201,
        };
      }),
    );
    expect(events[0].namespace).toBe(events[1].namespace);
    expect(events[0].keyHash).not.toBe(events[1].keyHash);
    expect(events[0]).toEqual({ ...events[2], outcome: 'created' });
    for (const index of [3, 4]) {
      expect(events[0].namespace).not.toBe(events[index].namespace);
      expect(events[0].keyHash).not.toBe(events[index].keyHash);
    }
  });

  it.each(['null', 'undefined', 'string', 'number', 'hostile object'])(
    'does not read or serialize an original thrown %s value for observations',
    async (kind) => {
      const storage = new FakeStorage();
      const access = jest.fn(() => {
        throw privateError();
      });
      const values: Record<string, unknown> = {
        null: null,
        undefined,
        string: secrets.message,
        number: 418,
        'hostile object': Object.defineProperties(
          {},
          {
            message: { get: access },
            name: { get: access },
            stack: { get: access },
            cause: { get: access },
            toJSON: { value: access },
            toString: { value: access },
          },
        ),
      };
      const thrown = values[kind];
      storage.get.mockRejectedValueOnce(thrown);
      const { run, next } = prepare(storage);

      await expect(run()).rejects.toBe(thrown);

      expectSingleEvent('storage_error', { error: { code: 'storage_failure', operation: 'get' } });
      expect(next.handleSpy).not.toHaveBeenCalled();
      expect(access).not.toHaveBeenCalled();
    },
  );

  it.each<FailureMode>(['sync throw', 'async reject'])(
    'logs safely when an observer mutates its event and then fails with %s',
    async (failureMode) => {
      const storage = new FakeStorage();
      storage.complete.mockRejectedValueOnce(privateError());
      const { run, onEvent } = prepare(storage);
      onEvent.mockImplementationOnce((event) => {
        // Record exactly what the package supplied, before external callback
        // code deliberately changes its own argument to contain secrets.
        events.push(structuredClone(event));
        Object.assign(event, {
          namespace: secrets.identity,
          keyHash: secrets.rawKey,
          error: { code: secrets.message, cause: secrets.cause },
        });
        return fail(failureMode, privateError())();
      });

      await expect(run()).resolves.toBe(handlerValue);

      expectSingleEvent('complete_error', {
        statusCode: 201,
        error: { code: 'storage_failure', operation: 'complete' },
      });
      expect(storage.delete).not.toHaveBeenCalled();
      expect(await storage.get(requestKey.key)).toMatchObject({ status: 'PROCESSING' });
    },
  );

  it('exposes complete_error while preserving a successful response and PROCESSING record', async () => {
    const storage = new FakeStorage();
    storage.complete.mockRejectedValueOnce(privateError());
    const { run, res } = prepare(storage, 'async reject', true);

    await expect(run()).resolves.toBe(handlerValue);

    expectSingleEvent('complete_error', {
      statusCode: 201,
      error: { code: 'storage_failure', operation: 'complete' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.getHeaders()['idempotency-status']).toBe('complete_error');
    expect(res.getHeaders()).not.toHaveProperty('idempotency-replayed');
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await storage.get(requestKey.key)).toMatchObject({ status: 'PROCESSING' });
  });
});
