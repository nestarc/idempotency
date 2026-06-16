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
import { stableJsonStringify } from '../src/utils/stable-json';
import type { IdempotencyOptions } from '../src/interfaces/idempotency-options.interface';
import type { IdempotentMetadata } from '../src/interfaces/idempotency-options.interface';

import { FakeStorage } from './support/fake-storage';
import {
  buildCallHandler,
  buildExecutionContext,
  buildResponse,
} from './support/execution-context.factory';

const sha256 = (input: unknown): string =>
  createHash('sha256').update(stableJsonStringify(input ?? null)!).digest('hex');

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
    // Most tests assert against the raw key (e.g. 'K1'). Use 'global' scope
    // to keep those assertions simple. Dedicated scope tests override this.
    scope: 'global',
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
        'cmd-123',
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
        'route-key',
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
        'async-key',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(BadRequestException);

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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBe(resolverError);

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
        expect.any(String), // token
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

    it('treats object key order differences as the same fingerprint', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.seed({
        key: 'K-stable',
        fingerprint: sha256({ a: { c: 3, d: 4 }, b: 2 }),
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: '{"ok":true}',
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
        key: 'K-custom-fp',
        fingerprint: 'order:order-1',
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: '{"ok":true}',
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
        key: 'K-custom-fp-mismatch',
        fingerprint: 'order:order-1',
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: '{"ok":true}',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

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
        'K-route-fp',
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
        'K-async-fp',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBe(resolverError);

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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBe(boom);

      expect(storage.delete).toHaveBeenCalledWith('K1', expect.any(String));
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

      expect(storage.delete).toHaveBeenCalledWith('K1', expect.any(String));
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
        'K-processing-ttl',
        expect.any(String),
        30,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        'K-processing-ttl',
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
        'K-handler-processing-ttl',
        expect.any(String),
        15,
      );
      expect(storage.complete).toHaveBeenCalledWith(
        'K-handler-processing-ttl',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toThrow(/processingTtl must be a positive integer/i);

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
      // next.handle() always returns an Observable in real Nest, but the
      // VALUE inside that observable can come from an awaited Promise.
      // Simulate by emitting once with a resolved value.
      const next = buildCallHandler(of({ fromPromise: true }));

      const result = await firstValueFrom(interceptor.intercept(context, next));

      expect(result).toEqual({ fromPromise: true });
      expect(storage.complete).toHaveBeenCalledWith(
        'K1',
        expect.any(String),
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
        expect.any(String),
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
      expect(storage.delete).toHaveBeenCalledWith('K1', expect.any(String));
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBe(boom);

      // delete was called and returned stale, but the error still propagates
      // without any additional exception being thrown.
      expect(storage.delete).toHaveBeenCalledWith('K1', expect.any(String));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Group J: observability and status headers
  // ──────────────────────────────────────────────────────────────────

  describe('J. observability and status headers', () => {
    it('emits a redacted created event and sets Idempotency-Status on first execution', async () => {
      const events: Array<{ outcome: string; keyHash: string }> = [];
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

      expect(res.setHeader).toHaveBeenCalledWith(
        'Idempotency-Status',
        'created',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: 'created' });
      expect(events[0].keyHash).not.toBe('K-created');
      expect(events[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
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
        key: 'K-replayed',
        fingerprint: sha256({ v: 1 }),
        status: 'COMPLETED',
        statusCode: 202,
        responseBody: '{"ok":true}',
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
      expect(res.setHeader).toHaveBeenCalledWith(
        'Idempotency-Status',
        'replayed',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Idempotency-Replayed',
        'true',
      );
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
        key: 'K-conflict',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Idempotency-Status',
        'conflict',
      );
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
        key: 'K-mismatch-observed',
        fingerprint: sha256({ v: 1 }),
        status: 'COMPLETED',
        statusCode: 200,
        responseBody: '{"ok":true}',
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

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Idempotency-Status',
        'mismatch',
      );
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

    it('emits bypassed for non-replayable responses', async () => {
      const events: Array<{ outcome: string }> = [];
      const { interceptor } = buildInterceptor({
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

    // Default = 'endpoint': the interceptor prepends method + actual path.
    it('scope=endpoint prefixes storage keys with HTTP method and actual request path', async () => {
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
        'POST /orders/123/capture::shared-key',
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
        interceptor.intercept(
          firstCtx.context,
          buildCallHandler(of({ id: 'cap_1' })),
        ),
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
        interceptor.intercept(
          secondCtx.context,
          buildCallHandler(of({ id: 'cap_2' })),
        ),
      );

      expect(secondResult).toEqual({ id: 'cap_2' });
      const createCalls = storage.create.mock.calls.map(([key]) => key);
      expect(createCalls).toContain('POST /orders/1/capture::shared-key');
      expect(createCalls).toContain('POST /orders/2/capture::shared-key');
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
        interceptor.intercept(
          firstCtx.context,
          buildCallHandler(of({ result: 'first' })),
        ),
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
        interceptor.intercept(
          secondCtx.context,
          buildCallHandler(of({ result: 'second' })),
        ),
      );

      expect(secondResult).toEqual({ result: 'first' });
      expect(storage.create).toHaveBeenCalledTimes(1);
      expect(storage.create).toHaveBeenCalledWith(
        'POST /search::query-key',
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
        interceptor.intercept(
          refundCtx.context,
          buildCallHandler(of({ kind: 'refund' })),
        ),
      );

      // The refund call returned the refund handler's own response, NOT a
      // replayed copy of the payment response.
      expect(refundResult).toEqual({ kind: 'refund' });

      // Both keys were created under different prefixes.
      const createCalls = storage.create.mock.calls.map(([key]) => key);
      expect(createCalls).toContain(
        'PaymentsController#createHandler::shared-key',
      );
      expect(createCalls).toContain(
        'RefundsController#refundHandler::shared-key',
      );
    });

    // Custom scope function
    it('scope=function applies the custom namespace', async () => {
      const { interceptor, storage } = buildInterceptor({
        scope: () => 'tenant-42',
      });
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
        'tenant-42::K1',
        expect.any(String),
        86_400,
      );
    });

    // Explicit 'global' scope: raw key, no prefix (legacy behavior).
    it('scope=global uses the raw header value with no prefix', async () => {
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
        'K1',
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
        'K-headers',
        expect.any(String),
        {
          statusCode: 201,
          body: '{"id":"pay_1"}',
          headers: {
            location: '/payments/pay_1',
            'x-request-id': 'req_1',
          },
        },
        86_400,
      );
      expect(storage.complete.mock.calls[0][2].headers).not.toHaveProperty(
        'set-cookie',
      );
    });

    it('replays stored headers and status for completed records', async () => {
      const { interceptor, storage } = buildInterceptor();
      const fp = sha256({ amount: 100 });
      storage.seed({
        key: 'K-replay-headers',
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 201,
        responseBody: '{"id":"pay_1"}',
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
      expect(res.setHeader).toHaveBeenCalledWith(
        'location',
        '/payments/pay_1',
      );
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
        'K-no-headers',
        expect.any(String),
        {
          statusCode: 201,
          body: '{"id":"pay_1"}',
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
        key: 'K-replay-disabled',
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 201,
        responseBody: '{"id":"pay_1"}',
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
        key: 'K-replay-allowlist',
        fingerprint: fp,
        status: 'COMPLETED',
        statusCode: 201,
        responseBody: '{"id":"pay_1"}',
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
      expect(res.setHeader).toHaveBeenCalledWith(
        'location',
        '/payments/pay_1',
      );
      expect(res.setHeader).not.toHaveBeenCalledWith(
        'x-request-id',
        expect.any(String),
      );
      expect(res.setHeader).not.toHaveBeenCalledWith(
        'etag',
        expect.any(String),
      );
      expect(res.setHeader).not.toHaveBeenCalledWith(
        'set-cookie',
        expect.any(String),
      );
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
      it(`skips caching for ${name} responses (delete + warn, caller still gets the value)`, async () => {
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
        const warnSpy = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation();

        const result = await firstValueFrom(
          interceptor.intercept(context, next),
        );

        // The caller receives the original value unchanged.
        expect(result).toBe(original);

        // complete() was NEVER called with a JSON'd version of the value.
        expect(storage.complete).not.toHaveBeenCalled();
        // The lock record was released so a future request can retry.
        expect(storage.delete).toHaveBeenCalledWith(
          `K-${name}`,
          expect.any(String),
        );
        // A warning explaining the type was emitted.
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/not a plain JSON value/i),
        );
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
