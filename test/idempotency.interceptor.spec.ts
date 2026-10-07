import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { createHash } from 'crypto';

import { IdempotencyInterceptor } from '../src/idempotency.interceptor';
import { Idempotent } from '../src/idempotency.decorator';
import { IDEMPOTENT_METADATA_KEY } from '../src/idempotency.constants';
import { stableJsonStringify } from '../src/utils/stable-json';
import { encodeReplayBody } from '../src/utils/replay-body';
import { createRequestKey } from '../src/utils/request-key';
import type {
  IdempotencyEvent,
  IdempotencyOptions,
} from '../src/interfaces/idempotency-options.interface';
import type { IdempotentMetadata } from '../src/interfaces/idempotency-options.interface';

import { FakeStorage } from './support/fake-storage';
import { globalRequestKey } from './support/request-key';
import {
  buildCallHandler,
  buildExecutionContext,
  buildResponse,
} from './support/execution-context.factory';

const sha256 = (input: unknown): string =>
  createHash('sha256')
    .update(stableJsonStringify(input ?? null)!)
    .digest('hex');

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

// Give asynchronous storage continuations a turn without guessing a duration.
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Convenience: build an interceptor wired to a fresh `FakeStorage` and the
 * given module options. Returns the interceptor + storage + reflector so each
 * test can reach in to assert behavior.
 */
const buildInterceptor = (overrides: Partial<IdempotencyOptions> = {}) => {
  const storage = new FakeStorage();
  const options: IdempotencyOptions = {
    storage,
    ttl: 86_400,
    headerName: 'Idempotency-Key',
    fingerprint: true,
    // Most tests isolate storage behavior from endpoint composition.
    // Global keys still use the versioned encoding; scope tests override this.
    scope: 'global',
    ...overrides,
  };
  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(reflector, storage, options);
  return { interceptor, storage, reflector, options };
};

/**
 * Attach chosen metadata to a fresh handler function. A separate test exercises
 * the real @Idempotent decorator rather than this programmable fixture.
 *
 * Returns the handler so tests can pass it to `buildExecutionContext`.
 * Each call gets a unique handler so metadata from one test cannot leak
 * into another.
 */
const decoratedHandler = (
  metadata?: Partial<IdempotentMetadata> | { enabled: false },
): ((...args: any[]) => any) => {
  const handler = function namedHandler() {
    return undefined;
  };
  if (metadata !== undefined) {
    Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, metadata, handler);
  }
  return handler;
};

describe('IdempotencyInterceptor', () => {
  // ──────────────────────────────────────────────────────────────────
  // Group A: header extraction
  // ──────────────────────────────────────────────────────────────────

  describe('A. header extraction', () => {
    // Case 1
    it('throws BadRequest when header is missing and required (default)', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: { method: 'POST', headers: {}, body: {} },
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(storage.get).not.toHaveBeenCalled();
      expect(storage.create).not.toHaveBeenCalled();
      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    // Case 2
    it('passes through when header is missing and required=false', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true, required: false });
      const { context } = buildExecutionContext({
        req: { method: 'POST', headers: {}, body: { x: 1 } },
        handler,
      });
      const next = buildCallHandler(of('handler-result'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBe('handler-result');
      expect(storage.get).not.toHaveBeenCalled();
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
    });

    // Case 3
    it('respects a custom headerName from module options', async () => {
      const { interceptor, storage } = buildInterceptor({
        headerName: 'X-Idem-Key',
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'x-idem-key': 'K-CUSTOM' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-CUSTOM'),
        expect.any(String),
        86_400,
      );
    });

    it('uses a module-level keyResolver when no header is present', async () => {
      const { interceptor, storage } = buildInterceptor({
        keyResolver: (ctx) => {
          const req = ctx.switchToHttp().getRequest<{ body: { commandId: string } }>();
          return req.body.commandId;
        },
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: {},
          body: { commandId: 'cmd-123', amount: 100 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('cmd-123'),
        expect.any(String),
        86_400,
      );
    });

    it('lets a route-level keyResolver override the module-level resolver', async () => {
      const { interceptor, storage } = buildInterceptor({
        keyResolver: () => 'module-key',
      });
      const handler = decoratedHandler({
        enabled: true,
        keyResolver: () => 'route-key',
      });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'header-key' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('route-key'),
        expect.any(String),
        86_400,
      );
    });

    it('supports an async keyResolver', async () => {
      const { interceptor, storage } = buildInterceptor({
        keyResolver: async () => 'async-key',
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: {},
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('async-key'),
        expect.any(String),
        86_400,
      );
    });

    it('treats an undefined keyResolver result like a missing key', async () => {
      const { interceptor, storage } = buildInterceptor({
        keyResolver: () => undefined,
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: {},
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(storage.get).not.toHaveBeenCalled();
      expect(storage.create).not.toHaveBeenCalled();
    });

    it('fails before storage access when keyResolver throws', async () => {
      const resolverError = new Error('resolver failed');
      const { interceptor, storage } = buildInterceptor({
        keyResolver: () => {
          throw resolverError;
        },
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: {},
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(
        resolverError,
      );

      expect(storage.get).not.toHaveBeenCalled();
      expect(storage.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group B: new-key happy path
  // ──────────────────────────────────────────────────────────────────

  describe('B. new-key happy path', () => {
    // Case 4 — the all-important concatMap ordering test
    it('captures the response and completes BEFORE emitting to the caller', async () => {
      const { interceptor, storage } = buildInterceptor();
      const completionStarted = deferred<void>();
      const allowCompletion = deferred<void>();
      const persist = storage.complete.getMockImplementation()!;
      storage.complete.mockImplementationOnce(async (...args) => {
        completionStarted.resolve();
        await allowCompletion.promise;
        return persist(...args);
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(201);
      const body = { ok: true };
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of(body));

      const emitted: unknown[] = [];
      const resultPromise = firstValueFrom(interceptor.intercept(context, next));
      void resultPromise.then(
        (value) => {
          emitted.push(value);
        },
        () => undefined,
      );

      try {
        // Unlike an immediate mock, this cannot mistake invoking complete()
        // for awaiting its acknowledgement before publishing success.
        await completionStarted.promise;
        await nextTurn();
        expect(emitted).toEqual([]);
        expect(await storage.get(globalRequestKey('K1'))).toMatchObject({
          status: 'PROCESSING',
        });
      } finally {
        allowCompletion.resolve();
      }
      const result = await resultPromise;

      // Returned value is the unmodified handler result.
      expect(result).toBe(body);

      // create + complete were called with the right shape.
      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        sha256({ amount: 100 }),
        86_400,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        (await storage.create.mock.results[0].value).token,
        {
          statusCode: 201,
          body: '@nestarc/idempotency:replay:v1:{"kind":"json","value":{"ok":true}}',
        },
        86_400,
      );

      expect(await storage.get(globalRequestKey('K1'))).toMatchObject({
        status: 'COMPLETED',
        statusCode: 201,
      });
      const retry = buildCallHandler(of({ duplicate: true }));
      await expect(firstValueFrom(interceptor.intercept(context, retry))).resolves.toEqual(body);
      expect(retry.handleSpy).not.toHaveBeenCalled();
      expect(storage.complete).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group C: replay
  // ──────────────────────────────────────────────────────────────────

  describe('C. replay', () => {
    // Case 5
    it('replays a COMPLETED record without invoking next.handle()', async () => {
      const { interceptor, storage } = buildInterceptor();
      const fp = sha256({ amount: 100 });
      storage.seed({
        key: globalRequestKey('K1'),
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 202,
        responseBody: encodeReplayBody({ id: 1 }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ id: 1 });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(next.handleSpy).not.toHaveBeenCalled();
      expect(storage.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group D: processing collision
  // ──────────────────────────────────────────────────────────────────

  describe('D. processing collision', () => {
    // Case 6
    it('throws Conflict when an existing record is PROCESSING', async () => {
      const { interceptor, storage } = buildInterceptor();
      const fp = sha256({ amount: 100 });
      storage.seed({
        key: globalRequestKey('K1'),
        fingerprint: fp,
        status: 'PROCESSING',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { amount: 100 },
        },
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    // Case 7
    it('throws Conflict when create() loses the race', async () => {
      const { interceptor, storage } = buildInterceptor();
      // get() returns null, but create() reports acquired=false
      // (another caller won the race).
      storage.create.mockResolvedValueOnce({ acquired: false });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { amount: 100 },
        },
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(next.handleSpy).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group E: fingerprint mismatch
  // ──────────────────────────────────────────────────────────────────

  describe('E. fingerprint mismatch', () => {
    // Case 8
    it('throws 422 for a COMPLETED record with a different fingerprint', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.seed({
        key: globalRequestKey('K1'),
        fingerprint: sha256({ amount: 100 }),
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: encodeReplayBody({}),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { amount: 200 }, // different body
        },
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    // Case 9 — mismatch beats processing
    it('prefers 422 over 409 when a PROCESSING record has a different fingerprint', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.seed({
        key: globalRequestKey('K1'),
        fingerprint: sha256({ amount: 100 }),
        status: 'PROCESSING',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { amount: 200 },
        },
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    // Case 10
    it('skips fingerprint verification when fingerprint=false', async () => {
      const { interceptor, storage } = buildInterceptor({ fingerprint: false });
      storage.seed({
        key: globalRequestKey('K1'),
        fingerprint: undefined,
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: encodeReplayBody({ id: 42 }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { anything: true },
        },
        res,
        handler,
      });
      const next = buildCallHandler();

      const result = await firstValueFrom(interceptor.intercept(context, next));
      expect(result).toEqual({ id: 42 });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('treats object key order differences as the same fingerprint', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.seed({
        key: globalRequestKey('K-stable'),
        fingerprint: sha256({ a: { c: 3, d: 4 }, b: 2 }),
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: encodeReplayBody({ ok: true }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-stable' },
          body: { b: 2, a: { d: 4, c: 3 } },
        },
        res,
        handler,
      });
      const next = buildCallHandler();

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ ok: true });
      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    it('uses a custom fingerprint resolver for replay comparison', async () => {
      const { interceptor, storage } = buildInterceptor({
        fingerprint: ({ body }) => {
          const value = body as { orderId: string };
          return `order:${value.orderId}`;
        },
      });
      storage.seed({
        key: globalRequestKey('K-custom-fp'),
        fingerprint: 'order:order-1',
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: encodeReplayBody({ ok: true }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-custom-fp' },
          body: { orderId: 'order-1', nonce: 'different-each-time' },
        },
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ ok: true });
      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    it('throws 422 when a custom fingerprint resolver returns a different fingerprint', async () => {
      const { interceptor, storage } = buildInterceptor({
        fingerprint: ({ body }) => {
          const value = body as { orderId: string };
          return `order:${value.orderId}`;
        },
      });
      storage.seed({
        key: globalRequestKey('K-custom-fp-mismatch'),
        fingerprint: 'order:order-1',
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: encodeReplayBody({ ok: true }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-custom-fp-mismatch' },
          body: { orderId: 'order-2' },
        },
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    it('lets a route-level custom fingerprint resolver override the module-level resolver', async () => {
      const { interceptor, storage } = buildInterceptor({
        fingerprint: () => 'module-fingerprint',
      });
      const handler = decoratedHandler({
        enabled: true,
        fingerprint: () => 'route-fingerprint',
      });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-route-fp' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-route-fp'),
        'route-fingerprint',
        86_400,
      );
    });

    it('supports an async custom fingerprint resolver', async () => {
      const { interceptor, storage } = buildInterceptor({
        fingerprint: async () => 'async-fingerprint',
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-async-fp' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-async-fp'),
        'async-fingerprint',
        86_400,
      );
    });

    it('fails before storage access when a custom fingerprint resolver throws', async () => {
      const resolverError = new Error('fingerprint failed');
      const { interceptor, storage } = buildInterceptor({
        fingerprint: () => {
          throw resolverError;
        },
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-fp-error' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(
        resolverError,
      );

      expect(storage.get).not.toHaveBeenCalled();
      expect(storage.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group F: handler errors
  // ──────────────────────────────────────────────────────────────────

  describe('F. handler errors', () => {
    // Case 11
    it('deletes the key and re-throws when the handler emits a generic error', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const boom = new Error('boom');
      const next = buildCallHandler(throwError(() => boom));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(boom);

      expect(storage.delete).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        (await storage.create.mock.results[0].value).token,
      );
      expect(storage.complete).not.toHaveBeenCalled();
      expect(await storage.get(globalRequestKey('K1'))).toBeNull();
      const retry = buildCallHandler(of({ retried: true }));
      await expect(firstValueFrom(interceptor.intercept(context, retry))).resolves.toEqual({
        retried: true,
      });
      expect(retry.handleSpy).toHaveBeenCalledTimes(1);
    });

    // Case 12
    it('preserves HttpException status when deleting on error', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const httpErr = new HttpException('no', 409);
      const next = buildCallHandler(throwError(() => httpErr));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(httpErr);

      expect(storage.delete).toHaveBeenCalledWith(globalRequestKey('K1'), expect.any(String));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group G: metadata gates
  // ──────────────────────────────────────────────────────────────────

  describe('G. metadata gates', () => {
    // Case 13
    it('passes through when no @Idempotent metadata is present', async () => {
      const { interceptor, storage } = buildInterceptor();
      // handler without metadata
      const handler = decoratedHandler();
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of('plain'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBe('plain');
      expect(storage.get).not.toHaveBeenCalled();
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
    });

    // Case 14
    it('passes through when metadata.enabled is false (escape hatch)', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: false });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of('plain'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBe('plain');
      expect(storage.get).not.toHaveBeenCalled();
    });

    // Sanity: confirm the real @Idempotent decorator wires up correctly through Reflector.
    it('reads metadata attached by the real @Idempotent decorator', async () => {
      const { interceptor, storage } = buildInterceptor();
      class C {
        @Idempotent()
        run() {
          return undefined;
        }
      }
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-real' },
          body: { v: 1 },
        },
        handler: C.prototype.run,
        controller: C,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-real'),
        sha256({ v: 1 }),
        86_400,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group H: robustness
  // ──────────────────────────────────────────────────────────────────

  describe('H. robustness', () => {
    // Case 15
    it('honors per-handler ttl override over the module default', async () => {
      const { interceptor, storage } = buildInterceptor({ ttl: 86_400 });
      const handler = decoratedHandler({ enabled: true, ttl: 3600 });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(globalRequestKey('K1'), expect.any(String), 3600);
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        expect.any(String), // token
        expect.any(Object),
        3600,
      );
    });

    it('uses processingTtl for create() and ttl for complete()', async () => {
      const { interceptor, storage } = buildInterceptor({
        ttl: 86_400,
        processingTtl: 30,
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-processing-ttl' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-processing-ttl'),
        expect.any(String),
        30,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K-processing-ttl'),
        expect.any(String),
        expect.any(Object),
        86_400,
      );
    });

    it('lets per-handler processingTtl override the module default', async () => {
      const { interceptor, storage } = buildInterceptor({
        ttl: 86_400,
        processingTtl: 300,
      });
      const handler = decoratedHandler({
        enabled: true,
        ttl: 3600,
        processingTtl: 15,
      });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-handler-processing-ttl' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-handler-processing-ttl'),
        expect.any(String),
        15,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K-handler-processing-ttl'),
        expect.any(String),
        expect.any(Object),
        3600,
      );
    });

    it('throws when processingTtl is not a positive integer', async () => {
      const { interceptor, storage } = buildInterceptor({
        processingTtl: 0,
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-invalid-processing-ttl' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toThrow(
        /processingTtl must be a positive integer/i,
      );

      expect(storage.get).not.toHaveBeenCalled();
      expect(storage.create).not.toHaveBeenCalled();
    });

    // Case 16
    it('captures responses from a Promise-returning handler', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const handlerStarted = deferred<void>();
      const handlerResult = deferred<{ fromPromise: boolean }>();
      // Nest flattens the handler promise into its response Observable.
      const next = buildCallHandler(
        defer(() => {
          handlerStarted.resolve();
          return handlerResult.promise;
        }),
      );
      const response = firstValueFrom(interceptor.intercept(context, next));
      try {
        await handlerStarted.promise;
        await nextTurn();
        expect(storage.complete).not.toHaveBeenCalled();
        expect(await storage.get(globalRequestKey('K1'))).toMatchObject({
          status: 'PROCESSING',
        });
        const duplicate = buildCallHandler(of({ duplicate: true }));
        await expect(
          firstValueFrom(interceptor.intercept(context, duplicate)),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(duplicate.handleSpy).not.toHaveBeenCalled();
      } finally {
        handlerResult.resolve({ fromPromise: true });
      }
      const result = await response;

      expect(result).toEqual({ fromPromise: true });
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        expect.any(String),
        { statusCode: 200, body: encodeReplayBody({ fromPromise: true }) },
        86_400,
      );
    });

    // Case 17
    it('caches and replays an undefined body (204-style)', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(204);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        res,
        handler,
      });
      const next = buildCallHandler(of(undefined));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBeUndefined();
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        expect.any(String),
        { statusCode: 204, body: encodeReplayBody(undefined) },
        86_400,
      );

      const retry = buildCallHandler(of('NEVER'));
      const replay = await firstValueFrom(interceptor.intercept(context, retry));

      expect(replay).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(204);
      expect(retry.handleSpy).not.toHaveBeenCalled();
      expect(storage.complete).toHaveBeenCalledTimes(1);
    });

    // Case 18
    it('preserves the processing lease and emits a circular response while blocking retries', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });

      // Build a circular object — JSON.stringify will throw on this.
      const circular: Record<string, unknown> = { name: 'circ' };
      circular.self = circular;

      const next = buildCallHandler(of(circular));
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBe(circular);
      expect(storage.complete).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(await storage.get(globalRequestKey('K1'))).toMatchObject({
        status: 'PROCESSING',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/not replayable.*retaining.*PROCESSING/i),
        expect.objectContaining({ code: 'response_not_replayable' }),
      );

      const retry = buildCallHandler(of('NEVER'));
      await expect(firstValueFrom(interceptor.intercept(context, retry))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(retry.handleSpy).not.toHaveBeenCalled();
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
      expect(storage.create).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    // Case 19
    it('treats GET method requests with metadata identically to POST (method-agnostic)', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'GET',
          headers: { 'idempotency-key': 'K-get' },
          body: { q: 'test' },
        },
        handler,
      });
      const next = buildCallHandler(of([{ id: 1 }]));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual([{ id: 1 }]);
      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K-get'),
        sha256({ q: 'test' }),
        86_400,
      );
      expect(storage.complete).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group I: token-based CAS (regression for TTL expiry race, P1 #1)
  // ──────────────────────────────────────────────────────────────────

  describe('I. token CAS (P1 #1 regression)', () => {
    // Stale complete: the slow caller's record was evicted and replaced.
    // The interceptor must emit the handler's response to the client but
    // MUST log a warn and NOT clobber the newer record.
    it('emits the handler value and warns when complete() returns stale', async () => {
      const { interceptor, storage } = buildInterceptor();
      // Force complete() to report stale regardless of inputs.
      storage.complete.mockResolvedValueOnce('stale');
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of({ result: 'ok' }));
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      const result = await firstValueFrom(interceptor.intercept(context, next));

      // The caller still gets the handler's response.
      expect(result).toEqual({ result: 'ok' });
      // A warning was emitted.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/stale token/i),
        expect.objectContaining({ code: 'stale_completion' }),
      );
      warnSpy.mockRestore();
    });

    // Stale delete (on handler error): silently tolerated.
    it('tolerates a stale delete() during error cleanup', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.delete.mockResolvedValueOnce('stale');
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const boom = new Error('handler exploded');
      const next = buildCallHandler(throwError(() => boom));

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(boom);

      // delete was called and returned stale, but the error still propagates
      // without any additional exception being thrown.
      expect(storage.delete).toHaveBeenCalledWith(globalRequestKey('K1'), expect.any(String));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group J: observability and status headers
  // ──────────────────────────────────────────────────────────────────

  describe('J. observability and status headers', () => {
    it('emits a redacted created event and sets Idempotency-Status on first execution', async () => {
      const events: IdempotencyEvent[] = [];
      const { interceptor } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(201);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-created' },
          body: { v: 1 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'created');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: 'created' });
      expect(events[0].keyHash).not.toBe('K-created');
      expect(events[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(events[0].namespace).toBe(
        '@nestarc/idempotency:namespace:v1:a8d13bfa12806deaf76cc6a84da9766e08aea45e65900b1d911f46f560a52b30',
      );
      expect(events[0]).not.toHaveProperty('scope');
      expect(JSON.stringify(events)).not.toContain('K-created');
    });

    it('sets replay status headers and emits replayed when returning a cached response', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor, storage } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      storage.seed({
        key: globalRequestKey('K-replayed'),
        fingerprint: sha256({ v: 1 }),
        status: 'COMPLETED',
        statusCode: 202,
        responseBody: encodeReplayBody({ ok: true }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-replayed' },
          body: { v: 1 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ ok: true });
      expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'replayed');
      expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
      expect(events.map((event) => event.outcome)).toEqual(['replayed']);
    });

    it('sets conflict status headers and emits conflict for an in-flight duplicate', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor, storage } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      storage.seed({
        key: globalRequestKey('K-conflict'),
        fingerprint: sha256({ v: 1 }),
        status: 'PROCESSING',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-conflict' },
          body: { v: 1 },
        },
        res,
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'conflict');
      expect(events.map((event) => event.outcome)).toEqual(['conflict']);
    });

    it('sets mismatch status headers and emits mismatch for fingerprint reuse', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor, storage } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      storage.seed({
        key: globalRequestKey('K-mismatch-observed'),
        fingerprint: sha256({ v: 1 }),
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: encodeReplayBody({ ok: true }),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-mismatch-observed' },
          body: { v: 2 },
        },
        res,
        handler,
      });
      const next = buildCallHandler();

      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'mismatch');
      expect(events.map((event) => event.outcome)).toEqual(['mismatch']);
    });

    it('emits stale when complete() reports a stale token', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor, storage } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      storage.complete.mockResolvedValueOnce('stale');
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-stale-observed' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ ok: true });
      expect(events.map((event) => event.outcome)).toEqual(['stale']);
      warnSpy.mockRestore();
    });

    it('emits complete_error when complete() throws and still emits the handler value', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor, storage } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      storage.complete.mockRejectedValueOnce(new Error('redis down'));
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-complete-error-observed' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ ok: true });
      expect(events.map((event) => event.outcome)).toEqual(['complete_error']);
      errorSpy.mockRestore();
    });

    it('emits bypassed while retaining the lease for a non-replayable response', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor, storage } = buildInterceptor({
        observability: {
          onEvent: (event) => {
            events.push(event);
          },
        },
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const handler = decoratedHandler({ enabled: true });
      const body = Buffer.from('not-json');
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-bypassed' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of(body));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBe(body);
      expect(events.map((event) => event.outcome)).toEqual(['bypassed']);
      expect(storage.complete).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(await storage.get(globalRequestKey('K-bypassed'))).toMatchObject({
        status: 'PROCESSING',
      });
      warnSpy.mockRestore();
    });

    it('swallows onEvent failures without changing the request result', async () => {
      const { interceptor } = buildInterceptor({
        observability: {
          onEvent: () => {
            throw new Error('metrics backend down');
          },
        },
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-event-throws' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ ok: true });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/observability onEvent/i),
        expect.objectContaining({ code: 'callback_failure' }),
      );
      warnSpy.mockRestore();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group K: scope variants (regression for cross-endpoint collision, P1 #2)
  // ──────────────────────────────────────────────────────────────────

  describe('K. scope (P1 #2 regression)', () => {
    class PaymentsController {}
    class RefundsController {}

    // Default = 'endpoint': the encoded namespace includes method + actual path.
    it('scope=endpoint encodes HTTP method and actual request path in storage keys', async () => {
      const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });
      const handler = decoratedHandler({ enabled: true });
      // Override the function name to make the assertion deterministic.
      Object.defineProperty(handler, 'name', { value: 'createHandler' });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/orders/123/capture?verbose=true',
          url: '/orders/:id/capture',
          headers: { 'idempotency-key': 'shared-key' },
          body: { v: 1 },
        },
        handler,
        controller: PaymentsController,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        createRequestKey(['endpoint', [], ['path', 'POST', '/orders/123/capture']], 'shared-key')
          .key,
        expect.any(String),
        86_400,
      );
    });

    it('same route template with different actual path params uses distinct scoped keys', async () => {
      const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });
      const handler = decoratedHandler({ enabled: true });
      Object.defineProperty(handler, 'name', { value: 'captureHandler' });
      Reflect.defineMetadata('path', 'orders', PaymentsController);
      Reflect.defineMetadata('path', ':id/capture', handler);

      const firstCtx = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/orders/1/capture',
          headers: { 'idempotency-key': 'shared-key' },
          body: { amount: 100 },
        },
        handler,
        controller: PaymentsController,
      });
      await firstValueFrom(
        interceptor.intercept(firstCtx.context, buildCallHandler(of({ id: 'cap_1' }))),
      );

      const secondCtx = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/orders/2/capture',
          headers: { 'idempotency-key': 'shared-key' },
          body: { amount: 100 },
        },
        handler,
        controller: PaymentsController,
      });
      const secondResult = await firstValueFrom(
        interceptor.intercept(secondCtx.context, buildCallHandler(of({ id: 'cap_2' }))),
      );

      expect(secondResult).toEqual({ id: 'cap_2' });
      const createCalls = storage.create.mock.calls.map(([key]) => key);
      expect(createCalls).toContain(
        createRequestKey(['endpoint', [], ['path', 'POST', '/orders/1/capture']], 'shared-key').key,
      );
      expect(createCalls).toContain(
        createRequestKey(['endpoint', [], ['path', 'POST', '/orders/2/capture']], 'shared-key').key,
      );
    });

    it('ignores query strings when scoping endpoint keys', async () => {
      const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });
      const handler = decoratedHandler({ enabled: true });

      const firstCtx = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/search?a=1',
          headers: { 'idempotency-key': 'query-key' },
          body: { q: 'shoes' },
        },
        handler,
        controller: PaymentsController,
      });
      await firstValueFrom(
        interceptor.intercept(firstCtx.context, buildCallHandler(of({ result: 'first' }))),
      );

      const secondCtx = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/search?b=2',
          headers: { 'idempotency-key': 'query-key' },
          body: { q: 'shoes' },
        },
        handler,
        controller: PaymentsController,
      });
      const secondResult = await firstValueFrom(
        interceptor.intercept(secondCtx.context, buildCallHandler(of({ result: 'second' }))),
      );

      expect(secondResult).toEqual({ result: 'first' });
      expect(storage.create).toHaveBeenCalledTimes(1);
      expect(storage.create).toHaveBeenCalledWith(
        createRequestKey(['endpoint', [], ['path', 'POST', '/search']], 'query-key').key,
        expect.any(String),
        86_400,
      );
    });

    // Different endpoints, same raw header value → different scoped keys,
    // so both should successfully process without collision.
    it('two different endpoints with the same header value do not collide under scope=endpoint', async () => {
      const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });

      // Payment call
      const payHandler = decoratedHandler({ enabled: true });
      Object.defineProperty(payHandler, 'name', { value: 'createHandler' });
      const payCtx = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'shared-key' },
          body: { amount: 100 },
        },
        handler: payHandler,
        controller: PaymentsController,
      });
      await firstValueFrom(
        interceptor.intercept(payCtx.context, buildCallHandler(of({ kind: 'pay' }))),
      );

      // Refund call — same header, different endpoint. Should go through cleanly.
      const refundHdl = decoratedHandler({ enabled: true });
      Object.defineProperty(refundHdl, 'name', { value: 'refundHandler' });
      const refundCtx = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'shared-key' },
          body: { amount: 100 },
        },
        handler: refundHdl,
        controller: RefundsController,
      });
      const refundResult = await firstValueFrom(
        interceptor.intercept(refundCtx.context, buildCallHandler(of({ kind: 'refund' }))),
      );

      // The refund call returned the refund handler's own response, NOT a
      // replayed copy of the payment response.
      expect(refundResult).toEqual({ kind: 'refund' });

      // Both keys were created under different endpoint namespaces.
      const createCalls = storage.create.mock.calls.map(([key]) => key);
      expect(createCalls).toContain(
        createRequestKey(
          ['endpoint', [], ['handler', 'POST', 'PaymentsController', 'createHandler']],
          'shared-key',
        ).key,
      );
      expect(createCalls).toContain(
        createRequestKey(
          ['endpoint', [], ['handler', 'POST', 'RefundsController', 'refundHandler']],
          'shared-key',
        ).key,
      );
    });

    // Custom scope function
    it('scope=function combines custom identity with the endpoint namespace', async () => {
      const { interceptor, storage } = buildInterceptor({
        scope: () => 'tenant-42',
      });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/payments',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        createRequestKey(['endpoint', ['tenant-42'], ['path', 'POST', '/payments']], 'K1').key,
        expect.any(String),
        86_400,
      );
    });

    // Explicit 'global' scope shares one encoded namespace across endpoints.
    it('scope=global encodes the key in the global namespace', async () => {
      const { interceptor, storage } = buildInterceptor({ scope: 'global' });
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K1' },
          body: {},
        },
        handler,
      });
      const next = buildCallHandler(of({ ok: true }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.create).toHaveBeenCalledWith(
        globalRequestKey('K1'),
        expect.any(String),
        86_400,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group K: response header capture/replay
  // ──────────────────────────────────────────────────────────────────

  describe('K. response header capture/replay', () => {
    it('captures allowed response headers before emitting original response', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(201, {
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
        'set-cookie': 'sid=secret',
      });
      const body = { id: 'pay_1' };
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-headers' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of(body));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toBe(body);
      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K-headers'),
        expect.any(String),
        {
          statusCode: 201,
          body: encodeReplayBody({ id: 'pay_1' }),
          headers: {
            location: '/payments/pay_1',
            'x-request-id': 'req_1',
          },
        },
        86_400,
      );
      expect(storage.complete.mock.calls[0][2].headers).not.toHaveProperty('set-cookie');
    });

    it('replays stored headers and status for completed records', async () => {
      const { interceptor, storage } = buildInterceptor();
      const fp = sha256({ amount: 100 });
      storage.seed({
        key: globalRequestKey('K-replay-headers'),
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 201,
        responseBody: encodeReplayBody({ id: 'pay_1' }),
        responseHeaders: {
          location: '/payments/pay_1',
          'x-request-id': 'req_1',
        },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-replay-headers' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ id: 'pay_1' });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.setHeader).toHaveBeenCalledWith('location', '/payments/pay_1');
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req_1');
      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    it('does not capture headers when replayHeaders=false', async () => {
      const { interceptor, storage } = buildInterceptor({
        replayHeaders: false,
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(201, {
        location: '/payments/pay_1',
      });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-no-headers' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of({ id: 'pay_1' }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.complete).toHaveBeenCalledWith(
        globalRequestKey('K-no-headers'),
        expect.any(String),
        {
          statusCode: 201,
          body: encodeReplayBody({ id: 'pay_1' }),
          headers: undefined,
        },
        86_400,
      );
    });

    it('does not replay stored headers when replayHeaders=false', async () => {
      const { interceptor, storage } = buildInterceptor({
        replayHeaders: false,
        observability: { exposeStatusHeaders: false },
      });
      const fp = sha256({ amount: 100 });
      storage.seed({
        key: globalRequestKey('K-replay-disabled'),
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 201,
        responseBody: encodeReplayBody({ id: 'pay_1' }),
        responseHeaders: {
          location: '/payments/pay_1',
          'x-request-id': 'req_1',
        },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-replay-disabled' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ id: 'pay_1' });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    it('filters stored replay headers through explicit allowlist', async () => {
      const { interceptor, storage } = buildInterceptor({
        replayHeaders: ['location'],
        observability: { exposeStatusHeaders: false },
      });
      const fp = sha256({ amount: 100 });
      storage.seed({
        key: globalRequestKey('K-replay-allowlist'),
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 201,
        responseBody: encodeReplayBody({ id: 'pay_1' }),
        responseHeaders: {
          location: '/payments/pay_1',
          'x-request-id': 'req_1',
          etag: '"pay_1"',
          'set-cookie': 'sid=secret',
        },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(200);
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-replay-allowlist' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of('NEVER'));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ id: 'pay_1' });
      expect(res.setHeader).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith('location', '/payments/pay_1');
      expect(res.setHeader).not.toHaveBeenCalledWith('x-request-id', expect.any(String));
      expect(res.setHeader).not.toHaveBeenCalledWith('etag', expect.any(String));
      expect(res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.any(String));
    });
  });

  // Group L: binary response detection (P2 regression)

  describe('L. binary response detection (P2 regression)', () => {
    const nonReplayableCases: Array<{ name: string; build: () => unknown }> = [
      {
        name: 'Buffer',
        build: () => Buffer.from('hello world', 'utf-8'),
      },
      {
        name: 'Uint8Array',
        build: () => new Uint8Array([1, 2, 3, 4]),
      },
      {
        name: 'ArrayBuffer',
        build: () => new ArrayBuffer(16),
      },
      {
        name: 'Node Readable-like (has pipe)',
        build: () => ({
          pipe: () => undefined,
          on: () => undefined,
        }),
      },
      {
        name: 'Web ReadableStream-like (has getReader)',
        build: () => ({
          getReader: () => ({ read: async () => ({ done: true }) }),
        }),
      },
    ];

    for (const { name, build } of nonReplayableCases) {
      it(`retains the processing lease for ${name} responses and blocks retries`, async () => {
        const { interceptor, storage } = buildInterceptor();
        const handler = decoratedHandler({ enabled: true });
        const { context } = buildExecutionContext({
          req: {
            method: 'GET',
            headers: { 'idempotency-key': `K-${name}` },
            body: {},
          },
          handler,
        });
        const original = build();
        const next = buildCallHandler(of(original));
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

        const result = await firstValueFrom(interceptor.intercept(context, next));

        // The caller receives the original value unchanged.
        expect(result).toBe(original);

        // complete() was NEVER called with a JSON'd version of the value.
        expect(storage.complete).not.toHaveBeenCalled();
        // The successful handler must not become immediately executable again.
        expect(storage.delete).not.toHaveBeenCalled();
        expect(await storage.get(globalRequestKey(`K-${name}`))).toMatchObject({
          status: 'PROCESSING',
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/not replayable.*retaining.*PROCESSING/i),
          expect.objectContaining({ code: 'response_not_replayable' }),
        );

        const retry = buildCallHandler(of('NEVER'));
        await expect(firstValueFrom(interceptor.intercept(context, retry))).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(retry.handleSpy).not.toHaveBeenCalled();
        expect(next.handleSpy).toHaveBeenCalledTimes(1);
        expect(storage.create).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
      });
    }

    it('still caches plain objects normally (sanity check that the guard is not too aggressive)', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-plain' },
          body: { v: 1 },
        },
        handler,
      });
      const next = buildCallHandler(of({ id: 1, nested: { a: [1, 2] } }));

      await firstValueFrom(interceptor.intercept(context, next));

      expect(storage.complete).toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });
});
