/**
 * Regression: response metadata access and diagnostic header writes could throw
 * after the business handler succeeded. The downstream catchError classified
 * those failures as handler errors and deleted a valid PROCESSING/COMPLETED
 * record. Keep cleanup upstream of capture, treat capture failures as bypass,
 * and make diagnostic headers best effort even on a closed/broken response.
 */
import 'reflect-metadata';
import { ConflictException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import type { IdempotencyEvent } from '../../src/interfaces/idempotency-options.interface';
import { MemoryStorage } from '../../src/storage/memory.storage';
import { buildCallHandler, buildExecutionContext, buildResponse, type FakeResponse } from '../support/execution-context.factory';
import { globalRequestKey } from '../support/request-key';

const secretError = new Error('capture-secret-must-not-enter-events');
const fail = () => { throw secretError; };
const key = globalRequestKey('capture-failure');

describe('REGRESSION: response capture is outside handler-error cleanup', () => {
  let storage: MemoryStorage;
  let events: IdempotencyEvent[];
  let interceptor: IdempotencyInterceptor;
  const handler = () => undefined;
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  const context = (res = buildResponse()) => buildExecutionContext({
    handler, res,
    req: { method: 'POST', headers: { 'idempotency-key': 'capture-failure' }, body: {} },
  }).context;

  beforeEach(() => {
    storage = new MemoryStorage();
    events = [];
    interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
      storage, scope: 'global', ttl: 60,
      observability: { onEvent: (event) => { events.push(event); } },
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(storage, 'delete');
    jest.spyOn(storage, 'complete');
  });
  afterEach(() => storage.onModuleDestroy());

  const mutations: Array<[string, (res: FakeResponse) => void]> = [
    ['headersSent getter', res => { Object.defineProperty(res, 'headersSent', { get: fail }); }],
    ['sent getter', res => { Object.defineProperty(res, 'sent', { get: fail }); }],
    ['raw getter', res => { Object.defineProperty(res, 'raw', { get: fail }); }],
    ['statusCode getter', res => { Object.defineProperty(res, 'statusCode', { get: fail }); }],
    ['getHeaders getter', res => { Object.defineProperty(res, 'getHeaders', { get: fail }); }],
    ['getHeaders call', res => { res.getHeaders.mockImplementation(fail); }],
    ['header value getter', res => {
      res.getHeaders.mockReturnValue(Object.defineProperty({}, 'x-result', { get: fail, enumerable: true }));
    }],
  ];

  it.each(mutations)('retains the lease when %s fails after business success', async (_name, mutate) => {
    const res = buildResponse();
    mutate(res);
    const value = { charged: true };
    const next = buildCallHandler(of(value));
    await expect(firstValueFrom(interceptor.intercept(context(res), next))).resolves.toBe(value);
    expect(next.handleSpy).toHaveBeenCalledTimes(1);
    expect(storage.complete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await storage.get(key)).toMatchObject({ status: 'PROCESSING' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'bypassed', error: { code: 'response_not_replayable' } });
    expect(JSON.stringify(events)).not.toContain(secretError.message);
    const retry = buildCallHandler(of('duplicate'));
    await expect(firstValueFrom(interceptor.intercept(context(), retry))).rejects.toBeInstanceOf(ConflictException);
    expect(retry.handleSpy).not.toHaveBeenCalled();
  });

  it.each(['created', 'stale', 'complete_error', 'bypassed'] as const)(
    'preserves %s when writing the diagnostic header throws', async (outcome) => {
      const res = buildResponse();
      res.setHeader.mockImplementation(fail);
      if (outcome === 'stale') jest.spyOn(storage, 'complete').mockResolvedValueOnce('stale');
      if (outcome === 'complete_error') jest.spyOn(storage, 'complete').mockRejectedValueOnce(secretError);
      const value = outcome === 'bypassed' ? new Date(0) : { charged: true };
      await expect(firstValueFrom(interceptor.intercept(context(res), buildCallHandler(of(value))))).resolves.toBe(value);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe(outcome);
      expect(await storage.get(key)).toMatchObject({ status: outcome === 'created' ? 'COMPLETED' : 'PROCESSING' });
    },
  );

  it('does not misclassify successful completion when setHeader property access throws', async () => {
    const res = buildResponse();
    Object.defineProperty(res, 'setHeader', { get: fail });
    await expect(firstValueFrom(interceptor.intercept(context(res), buildCallHandler(of({ charged: true }))))).resolves.toEqual({ charged: true });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(events.map(event => event.outcome)).toEqual(['created']);
    expect(await storage.get(key)).toMatchObject({ status: 'COMPLETED' });
  });
});
