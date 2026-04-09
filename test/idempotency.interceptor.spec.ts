import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { createHash } from 'crypto';

import { IdempotencyInterceptor } from '../src/idempotency.interceptor';
import { Idempotent } from '../src/idempotency.decorator';
import { IDEMPOTENT_METADATA_KEY } from '../src/idempotency.constants';
import type { IdempotencyOptions } from '../src/interfaces/idempotency-options.interface';
import type { IdempotentMetadata } from '../src/interfaces/idempotency-options.interface';

import { FakeStorage } from './support/fake-storage';
import {
  buildCallHandler,
  buildExecutionContext,
  buildResponse,
} from './support/execution-context.factory';

const sha256 = (input: unknown): string =>
  createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');

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
    ...overrides,
  };
  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(reflector, storage, options);
  return { interceptor, storage, reflector, options };
};

/**
 * Decorate a fresh handler function with `@Idempotent(options?)`.
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(BadRequestException);

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
        'K-CUSTOM',
        expect.any(String),
        86_400,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group B: new-key happy path
  // ──────────────────────────────────────────────────────────────────

  describe('B. new-key happy path', () => {
    // Case 4 — the all-important concatMap ordering test
    it('captures the response and completes BEFORE emitting to the caller', async () => {
      const { interceptor, storage } = buildInterceptor();
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

      const result = await firstValueFrom(interceptor.intercept(context, next));

      // Returned value is the unmodified handler result.
      expect(result).toBe(body);

      // create + complete were called with the right shape.
      expect(storage.create).toHaveBeenCalledWith(
        'K1',
        sha256({ amount: 100 }),
        86_400,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        'K1',
        { statusCode: 201, body: '{"ok":true}' },
        86_400,
      );

      // CRITICAL: complete must appear in the ledger BEFORE the outer observable
      // is allowed to emit. The order is encoded in the ledger ops; if the
      // implementation uses tap() (fire-and-forget) instead of concatMap(),
      // the create→complete pair would race against the emission and the
      // ledger order would be non-deterministic. firstValueFrom awaits the
      // emission, so by the time we get here we know complete already ran.
      const ops = storage.ledger.map((entry) => entry.op);
      expect(ops).toEqual(['get', 'create', 'complete']);
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
        key: 'K1',
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 202,
        responseBody: '{"id":1}',
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
        key: 'K1',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    // Case 7
    it('throws Conflict when create() loses the race', async () => {
      const { interceptor, storage } = buildInterceptor();
      // get() returns null, but create() reports false (another caller won).
      storage.create.mockResolvedValueOnce(false);
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(ConflictException);

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
        key: 'K1',
        fingerprint: sha256({ amount: 100 }),
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: '{}',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(next.handleSpy).not.toHaveBeenCalled();
    });

    // Case 9 — mismatch beats processing
    it('prefers 422 over 409 when a PROCESSING record has a different fingerprint', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.seed({
        key: 'K1',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    // Case 10
    it('skips fingerprint verification when fingerprint=false', async () => {
      const { interceptor, storage } = buildInterceptor({ fingerprint: false });
      storage.seed({
        key: 'K1',
        fingerprint: undefined,
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: '{"id":42}',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBe(boom);

      expect(storage.delete).toHaveBeenCalledWith('K1');
      expect(storage.complete).not.toHaveBeenCalled();
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBe(httpErr);

      expect(storage.delete).toHaveBeenCalledWith('K1');
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
        'K-real',
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

      expect(storage.create).toHaveBeenCalledWith(
        'K1',
        expect.any(String),
        3600,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        'K1',
        expect.any(Object),
        3600,
      );
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
      // next.handle() always returns an Observable in real Nest, but the
      // VALUE inside that observable can come from an awaited Promise.
      // Simulate by emitting once with a resolved value.
      const next = buildCallHandler(of({ fromPromise: true }));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ fromPromise: true });
      expect(storage.complete).toHaveBeenCalledWith(
        'K1',
        { statusCode: 200, body: '{"fromPromise":true}' },
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
        'K1',
        { statusCode: 204, body: undefined },
        86_400,
      );
    });

    // Case 18
    it('logs a warning, deletes the key, and still emits when the response is not JSON-serializable', async () => {
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
      expect(storage.delete).toHaveBeenCalledWith('K1');
      expect(warnSpy).toHaveBeenCalled();

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
        'K-get',
        sha256({ q: 'test' }),
        86_400,
      );
      expect(storage.complete).toHaveBeenCalled();
    });
  });
});
