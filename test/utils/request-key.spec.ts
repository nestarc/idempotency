import { createRequestKey, type RequestNamespace } from '../../src/utils/request-key';
import { globalRequestKey } from '../support/request-key';

describe('versioned request key format', () => {
  it('pins the v1 storage and namespace encoding for existing records', () => {
    expect(globalRequestKey('K')).toBe(
      '@nestarc/idempotency:key:v1:c6a914c4bef8f2dde13ea073bbc5a60e31e14f51b0e36a96fbcbe066e056b615',
    );
    expect(createRequestKey(['global'], 'K')).toEqual({
      key: '@nestarc/idempotency:key:v1:c6a914c4bef8f2dde13ea073bbc5a60e31e14f51b0e36a96fbcbe066e056b615',
      namespace:
        '@nestarc/idempotency:namespace:v1:a8d13bfa12806deaf76cc6a84da9766e08aea45e65900b1d911f46f560a52b30',
    });
    expect(
      createRequestKey(['endpoint', ['tenant', 'user'], ['path', 'POST', '/payments']], 'K'),
    ).toEqual({
      key: '@nestarc/idempotency:key:v1:67032119594d17405c581afadd9e7b6b5071b910b4a6900efdf50444e85ae539',
      namespace:
        '@nestarc/idempotency:namespace:v1:11373ce39876934fbb36008dd6f6f3750a6f6a15185851bb4f9504001d601fcc',
    });
  });

  it('keeps the namespace independent of the raw key for the S4 handoff', () => {
    const scope: RequestNamespace = ['endpoint', ['tenant', 'user'], ['path', 'POST', '/payments']];
    const first = createRequestKey(scope, 'sensitive-business-key');
    const second = createRequestKey(scope, 'different-key');
    expect(first.namespace).toBe(second.namespace);
    expect(first.key).not.toBe(second.key);
    expect(JSON.stringify(first)).not.toContain('sensitive-business-key');
    expect(first.namespace).not.toBe(
      createRequestKey(['global'], 'sensitive-business-key').namespace,
    );
    expect(first.namespace).not.toBe(
      createRequestKey(
        ['endpoint', ['other-tenant', 'user'], ['path', 'POST', '/payments']],
        'sensitive-business-key',
      ).namespace,
    );
  });

  it('bounds storage key length even when the actual path and identity are long', () => {
    const { key } = createRequestKey(
      ['endpoint', ['tenant'.repeat(1000)], ['path', 'POST', `/${'resource'.repeat(1000)}`]],
      'K',
    );
    expect(Buffer.byteLength(key, 'utf8')).toBe(92);
  });

  it('preserves component boundaries that delimiter concatenation would collide', () => {
    const endpoint = ['path', 'POST', '/payments'] as const;
    const identities: readonly string[][] = [['tenant:a', 'b'], ['tenant', 'a:b'], ['tenant:a:b']];
    const keys = identities.map(
      (identity) => createRequestKey(['endpoint', identity, endpoint], 'key').key,
    );
    expect(new Set(keys).size).toBe(identities.length);
    expect(
      createRequestKey(['endpoint', ['tenant'], ['path', 'POST', '/a:key']], 'suffix').key,
    ).not.toBe(
      createRequestKey(['endpoint', ['tenant'], ['path', 'POST', '/a']], 'key:suffix').key,
    );
  });
});
