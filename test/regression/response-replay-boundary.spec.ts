/**
 * Regression: old COMPLETED records may contain fields excluded from the first
 * HTTP response. Replaying unversioned JSON cannot recover class metadata.
 * Reject it without applying cached headers or deleting/re-running the work.
 * Fixtures use current encoded keys to exercise body validation independently
 * of the S3 rule that legacy storage keys are never read.
 * Manual response detection must use the route property, not a function name.
 */
import 'reflect-metadata';
import { Res, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { Idempotent } from '../../src/idempotency.decorator';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { FakeStorage } from '../support/fake-storage';
import { globalRequestKey } from '../support/request-key';
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';

const PREFIX = '@nestarc/idempotency:replay:v1:';

const harness = () => {
  const storage = new FakeStorage();
  const onEvent = jest.fn();
  const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
    storage,
    scope: 'global',
    fingerprint: false,
    observability: { onEvent },
  });
  const handler = () => undefined;
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  const { context, res } = buildExecutionContext({
    req: { method: 'POST', headers: { 'idempotency-key': 'legacy' }, body: {} },
    handler,
  });
  return { storage, onEvent, interceptor, context, res };
};

describe('REGRESSION: safe replay boundary', () => {
  it.each([
    ['legacy JSON with an excluded field', '{"id":1,"secret":"private"}'],
    ['legacy empty body', undefined],
    ['malformed JSON', '{broken'],
    ['unknown version', '@nestarc/idempotency:replay:v2:{"kind":"json","value":1}'],
    ['malformed current body', `${PREFIX}{broken`],
    ['invalid current envelope', `${PREFIX}{"kind":"json"}`],
  ])('blocks %s without restoring headers or re-executing', async (_name, responseBody) => {
    const { storage, onEvent, interceptor, context, res } = harness();
    storage.seed({
      key: globalRequestKey('legacy'),
      status: 'COMPLETED',
      statusCode: 201,
      responseBody,
      responseHeaders: { location: '/old', 'x-original-secret': 'private' },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const original = await storage.get(globalRequestKey('legacy'));
    const next = buildCallHandler(of({ duplicate: true }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toMatchObject({
        status: 409,
      });
    }
    expect(res.status).not.toHaveBeenCalled();
    expect(res.getHeaders()).toEqual({ 'idempotency-status': 'conflict' });
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'conflict' }));
    expect(next.handleSpy).not.toHaveBeenCalled();
    expect(storage.create).not.toHaveBeenCalled();
    expect(storage.complete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await storage.get(globalRequestKey('legacy'))).toEqual(original);
  });

  it('keeps fingerprint mismatch priority over an unreadable completed response', async () => {
    const { storage, context, res } = harness();
    const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
      storage,
      scope: 'global',
      fingerprint: () => 'current-fingerprint',
    });
    storage.seed({
      key: globalRequestKey('legacy'),
      status: 'COMPLETED',
      fingerprint: 'previous-fingerprint',
      responseBody: '{"secret":"private"}',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const original = await storage.get(globalRequestKey('legacy'));
    const next = buildCallHandler(of({ duplicate: true }));
    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toMatchObject({
      status: 422,
    });
    expect(next.handleSpy).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.getHeaders()).toEqual({ 'idempotency-status': 'mismatch' });
    expect(storage.create).not.toHaveBeenCalled();
    expect(storage.complete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await storage.get(globalRequestKey('legacy'))).toEqual(original);
  });

  it('finds manual response metadata on an inherited, renamed handler property', async () => {
    class ParentController {
      @Idempotent()
      handle(@Res() _response: unknown) {
        return undefined;
      }
    }
    class ChildController extends ParentController {}
    Object.defineProperty(ParentController.prototype.handle, 'name', { value: 'wrappedHandler' });
    const { storage, interceptor } = harness();
    const { context } = buildExecutionContext({
      req: { method: 'POST', headers: { 'idempotency-key': 'manual' }, body: {} },
      controller: ChildController,
      handler: ChildController.prototype.handle,
    });
    const next = buildCallHandler();
    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toMatchObject({
      status: 500,
    });
    expect(next.handleSpy).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('rejects decorated non-HTTP contexts before accessing HTTP state', async () => {
    const { interceptor, storage, context } = harness();
    context.getType = (() => 'rpc') as ExecutionContext['getType'];
    context.switchToHttp = jest.fn(() => {
      throw new Error('not HTTP');
    });
    const next = buildCallHandler();
    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toMatchObject({
      status: 500,
    });
    expect(context.switchToHttp).not.toHaveBeenCalled();
    expect(next.handleSpy).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });
});
