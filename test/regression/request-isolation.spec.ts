/**
 * Regression tests for S3 — request identity and storage-key isolation.
 *
 * Before S3, a custom scope replaced HTTP method/path, so a tenant-only
 * scope could replay a payment response for a refund. Concatenating endpoint
 * and client key with `::` also allowed distinct endpoint/key pairs to collide.
 *
 * The fix adds identity components to endpoint scope and encodes the complete
 * tuple without ambiguous separators. Explicit global scope remains shared.
 * New versioned keys do not look up legacy aliases; consequently a legacy
 * completed operation can execute again without an upgrade barrier. An old
 * global raw key can nevertheless equal a new encoded address, so migration
 * requires a fresh physical namespace plus a business deduplication/drain plan.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import type { IdempotencyScope } from '../../src/interfaces/idempotency-options.interface';
import { MemoryStorage } from '../../src/storage/memory.storage';
import { encodeReplayBody } from '../../src/utils/replay-body';
import { buildCallHandler, buildExecutionContext } from '../support/execution-context.factory';

interface RequestCase {
  tenant: string;
  user: string;
  method: string;
  path: string;
  key: string;
}

const baseRequest: RequestCase = {
  tenant: 'tenant-a',
  user: 'user-a',
  method: 'POST',
  path: '/payments',
  key: 'K',
};

const tenantScope: IdempotencyScope = (context) =>
  context.switchToHttp().getRequest<{ user: { tenantId: string } }>().user.tenantId;

const identityScope: IdempotencyScope = (context) => {
  const { user } = context.switchToHttp().getRequest<{ user: { tenantId: string; id: string } }>();
  return [user.tenantId, user.id] as const;
};

describe('REGRESSION: request isolation', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.onModuleDestroy();
  });

  const prepareInvocation = (
    scope: IdempotencyScope,
    request: Partial<RequestCase> = {},
    body: unknown = { operation: 'executed' },
  ) => {
    const input = { ...baseRequest, ...request };
    const handler = function execute() {};
    Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
    const req = {
      method: input.method,
      originalUrl: input.path,
      headers: { 'idempotency-key': input.key },
      body: { amount: 100 },
      user: { tenantId: input.tenant, id: input.user },
    };
    const { context } = buildExecutionContext({ req, handler });
    const next = buildCallHandler(of(body));
    const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
      storage,
      scope,
    });
    return { context, next, interceptor };
  };

  const invoke = async (
    scope: IdempotencyScope,
    request: Partial<RequestCase> = {},
    body: unknown = { operation: 'executed' },
  ) => {
    const { context, next, interceptor } = prepareInvocation(scope, request, body);
    const result = await firstValueFrom(interceptor.intercept(context, next));
    return { result, handleSpy: next.handleSpy };
  };

  const discoverNewStorageAddress = async (): Promise<string> => {
    const create = jest.spyOn(storage, 'create');
    await invoke('endpoint');
    const address = create.mock.calls[0][0];
    create.mockRestore();
    await storage.onModuleDestroy();
    return address;
  };

  it('retains endpoint isolation when a custom scope returns only the tenant', async () => {
    const payment = await invoke(tenantScope, {}, { operation: 'payment' });
    const refund = await invoke(tenantScope, { path: '/refunds' }, { operation: 'refund' });

    expect(payment.result).toEqual({ operation: 'payment' });
    expect(refund.result).toEqual({ operation: 'refund' });
    expect(refund.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('does not collide when `::` moves between an endpoint and the raw key', async () => {
    await invoke('endpoint', { key: 'archive::K' }, { operation: 'payment' });
    const archived = await invoke(
      'endpoint',
      { path: '/payments::archive' },
      { operation: 'archive' },
    );

    expect(archived.result).toEqual({ operation: 'archive' });
    expect(archived.handleSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<RequestCase>]>([
    ['tenant', { tenant: 'tenant-b' }],
    ['user', { user: 'user-b' }],
    ['method', { method: 'PUT' }],
    ['endpoint', { path: '/refunds/42' }],
    ['path parameter', { path: '/payments/43' }],
    ['key', { key: 'other-key' }],
  ])('isolates a changed %s and replays only that request on retry', async (_, changed) => {
    const original = { path: '/payments/42' };
    const variant = { ...original, ...changed };
    await invoke(identityScope, original, { operation: 'original' });
    const distinct = await invoke(identityScope, variant, { operation: 'distinct' });
    const retry = await invoke(identityScope, variant, { operation: 'must-not-run' });
    const originalRetry = await invoke(identityScope, original, { operation: 'must-not-run' });

    expect(distinct.result).toEqual({ operation: 'distinct' });
    expect(distinct.handleSpy).toHaveBeenCalledTimes(1);
    expect(retry.result).toEqual({ operation: 'distinct' });
    expect(retry.handleSpy).not.toHaveBeenCalled();
    expect(originalRetry.result).toEqual({ operation: 'original' });
    expect(originalRetry.handleSpy).not.toHaveBeenCalled();
  });

  it.each(['::', ',', '","'])(
    'preserves tenant/user boundaries with %s inside identities',
    async (separator) => {
      await invoke(identityScope, { tenant: `a${separator}b`, user: 'c' }, { owner: 'first' });
      const distinct = await invoke(
        identityScope,
        { tenant: 'a', user: `b${separator}c` },
        { owner: 'second' },
      );

      expect(distinct.result).toEqual({ owner: 'second' });
      expect(distinct.handleSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the boundary between a custom identity and the raw key', async () => {
    await invoke(tenantScope, { tenant: 'a::b', key: 'c' }, { owner: 'first' });
    const distinct = await invoke(tenantScope, { tenant: 'a', key: 'b::c' }, { owner: 'second' });

    expect(distinct.result).toEqual({ owner: 'second' });
    expect(distinct.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('does not merge one identity component with multiple components', async () => {
    await invoke(() => 'tenant,user', {}, { owner: 'single' });
    const distinct = await invoke(() => ['tenant', 'user'], {}, { owner: 'multiple' });

    expect(distinct.result).toEqual({ owner: 'multiple' });
    expect(distinct.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a string identity as its equivalent one-element array', async () => {
    await invoke(() => 'tenant-a', {}, { operation: 'original' });
    const retry = await invoke(() => ['tenant-a'], {}, { operation: 'must-not-run' });

    expect(retry.result).toEqual({ operation: 'original' });
    expect(retry.handleSpy).not.toHaveBeenCalled();
  });

  it('does not infer authentication identity for endpoint scope', async () => {
    await invoke('endpoint', {}, { operation: 'original' });
    const retry = await invoke('endpoint', { tenant: 'tenant-b', user: 'user-b' });

    expect(retry.result).toEqual({ operation: 'original' });
    expect(retry.handleSpy).not.toHaveBeenCalled();
  });

  it('shares across endpoints and identities only when global scope is explicit', async () => {
    await invoke('global', {}, { operation: 'original' });
    const retry = await invoke('global', {
      method: 'DELETE',
      path: '/refunds/123',
      tenant: 'tenant-b',
      user: 'user-b',
    });

    expect(retry.result).toEqual({ operation: 'original' });
    expect(retry.handleSpy).not.toHaveBeenCalled();
  });

  it('keeps endpoint, custom identity, and global namespaces separate', async () => {
    await invoke('global', {}, { namespace: 'global' });
    const endpoint = await invoke('endpoint', {}, { namespace: 'endpoint' });
    const custom = await invoke(tenantScope, {}, { namespace: 'custom' });

    expect(endpoint.result).toEqual({ namespace: 'endpoint' });
    expect(custom.result).toEqual({ namespace: 'custom' });
    expect(endpoint.handleSpy).toHaveBeenCalledTimes(1);
    expect(custom.handleSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string]>([
    ['duplicate slash', '/payments//42'],
    ['trailing slash', '/payments/42/'],
    ['percent encoding', '/payments/%34%32'],
  ])('preserves a distinct actual path with a %s', async (_, path) => {
    await invoke('endpoint', { path: '/payments/42' }, { resource: 'original' });
    const distinct = await invoke('endpoint', { path }, { resource: 'distinct' });

    expect(distinct.result).toEqual({ resource: 'distinct' });
    expect(distinct.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('does not decode an encoded slash into another resource path', async () => {
    await invoke('endpoint', { path: '/payments/a/b' }, { resource: 'nested' });
    const distinct = await invoke('endpoint', { path: '/payments/a%2Fb' }, { resource: 'encoded' });

    expect(distinct.result).toEqual({ resource: 'encoded' });
    expect(distinct.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('excludes query parameters from scope so an identical operation still replays', async () => {
    await invoke(identityScope, { path: '/payments/42?tracking=first' }, { operation: 'original' });
    const retry = await invoke(identityScope, { path: '/payments/42?tracking=second' });

    expect(retry.result).toEqual({ operation: 'original' });
    expect(retry.handleSpy).not.toHaveBeenCalled();
  });

  it.each<[string, IdempotencyScope, string]>([
    ['endpoint', 'endpoint', 'POST /payments::K'],
    ['custom identity', tenantScope, 'tenant-a::K'],
    ['global', 'global', 'K'],
  ])(
    'does not look up or mutate a distinct legacy %s alias, allowing reexecution after an unsafe upgrade',
    async (_, scope, legacyKey) => {
      const acquired = await storage.create(legacyKey, undefined, 60);
      expect(acquired.acquired).toBe(true);
      await storage.complete(
        legacyKey,
        acquired.token!,
        {
          statusCode: 200,
          body: encodeReplayBody({ operation: 'legacy-completed' }),
        },
        60,
      );
      const legacyRecord = await storage.get(legacyKey);
      const get = jest.spyOn(storage, 'get');
      const create = jest.spyOn(storage, 'create');
      const complete = jest.spyOn(storage, 'complete');
      const remove = jest.spyOn(storage, 'delete');

      const fresh = await invoke(scope, {}, { operation: 'executed-again' });
      const retry = await invoke(scope, {}, { operation: 'must-not-run' });

      expect(fresh.result).toEqual({ operation: 'executed-again' });
      expect(fresh.handleSpy).toHaveBeenCalledTimes(1);
      expect(retry.result).toEqual({ operation: 'executed-again' });
      expect(retry.handleSpy).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalledWith(legacyKey);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).not.toBe(legacyKey);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0][0]).toBe(create.mock.calls[0][0]);
      expect(remove).not.toHaveBeenCalled();
      expect(await storage.get(legacyKey)).toEqual(legacyRecord);
    },
  );

  it('returns 409 without executing when an old global raw key equals the new address and stores a 0.4 payload', async () => {
    const address = await discoverNewStorageAddress();
    // Old global scope used any raw key verbatim, including an address that
    // happens to look like a v1 key. A version prefix cannot separate these.
    const acquired = await storage.create(address, undefined, 60);
    await storage.complete(
      address,
      acquired.token!,
      {
        statusCode: 200,
        body: JSON.stringify({ operation: 'legacy-completed' }),
      },
      60,
    );
    const legacyRecord = await storage.get(address);
    const create = jest.spyOn(storage, 'create');
    const complete = jest.spyOn(storage, 'complete');
    const remove = jest.spyOn(storage, 'delete');
    const { context, next, interceptor } = prepareInvocation('endpoint');

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toMatchObject({
      status: 409,
    });

    expect(next.handleSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await storage.get(address)).toEqual(legacyRecord);
  });

  it('isolates an exact legacy address overlap with an S1 payload when migration uses a fresh physical namespace', async () => {
    const address = await discoverNewStorageAddress();
    const oldStorage = new MemoryStorage();
    try {
      const acquired = await oldStorage.create(address, undefined, 60);
      await oldStorage.complete(
        address,
        acquired.token!,
        {
          statusCode: 200,
          body: encodeReplayBody({ operation: 'legacy-completed' }),
        },
        60,
      );
      const legacyRecord = await oldStorage.get(address);
      const getOld = jest.spyOn(oldStorage, 'get');
      const createOld = jest.spyOn(oldStorage, 'create');
      const completeOld = jest.spyOn(oldStorage, 'complete');
      const deleteOld = jest.spyOn(oldStorage, 'delete');
      const createNew = jest.spyOn(storage, 'create');

      const fresh = await invoke('endpoint', {}, { operation: 'new-namespace' });
      const retry = await invoke('endpoint', {}, { operation: 'must-not-run' });

      expect(fresh.result).toEqual({ operation: 'new-namespace' });
      expect(fresh.handleSpy).toHaveBeenCalledTimes(1);
      expect(retry.result).toEqual({ operation: 'new-namespace' });
      expect(retry.handleSpy).not.toHaveBeenCalled();
      expect(createNew).toHaveBeenCalledTimes(1);
      expect(createNew.mock.calls[0][0]).toBe(address);
      expect(getOld).not.toHaveBeenCalled();
      expect(createOld).not.toHaveBeenCalled();
      expect(completeOld).not.toHaveBeenCalled();
      expect(deleteOld).not.toHaveBeenCalled();
      expect(await oldStorage.get(address)).toEqual(legacyRecord);
    } finally {
      await oldStorage.onModuleDestroy();
    }
  });
});
