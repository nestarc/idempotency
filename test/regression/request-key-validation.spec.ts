/**
 * Regression tests for S3 — validate request keys before doing any work.
 *
 * Previously falsy keys bypassed optional idempotency, header arrays silently
 * selected their first element, and the length limit counted UTF-16 code units.
 * Non-string resolver results and invalid scope/length configuration could reach
 * storage. Validate the complete raw input before fingerprinting, storage reads
 * or writes, and handler execution; preserve accepted strings exactly.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import type { IdempotencyOptions } from '../../src/interfaces/idempotency-options.interface';
import { FakeStorage } from '../support/fake-storage';
import { MemoryStorage } from '../../src/storage/memory.storage';
import {
  buildCallHandler,
  buildExecutionContext,
  type FakeRequest,
} from '../support/execution-context.factory';

interface InputCase {
  key?: unknown;
  options?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  request?: Record<string, unknown>;
}

const prepare = ({ key = 'K', options, metadata, request }: InputCase = {}) => {
  const storage = new FakeStorage();
  const fingerprint = jest.fn(() => 'fingerprint');
  const handler = () => undefined;
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true, ...metadata }, handler);
  const { context } = buildExecutionContext({
    req: {
      method: 'POST',
      originalUrl: '/payments',
      headers: { 'idempotency-key': key },
      body: { amount: 100 },
      ...request,
    } as unknown as FakeRequest,
    handler,
  });
  const next = buildCallHandler(of({ ok: true }));
  const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
    storage,
    fingerprint,
    ...options,
  } as IdempotencyOptions);
  return {
    storage,
    fingerprint,
    next,
    invoke: () => firstValueFrom(interceptor.intercept(context, next)),
  };
};

type Prepared = ReturnType<typeof prepare>;

const expectNoIdempotencyWork = ({ storage, fingerprint }: Prepared) => {
  expect(storage.get).not.toHaveBeenCalled();
  expect(storage.create).not.toHaveBeenCalled();
  expect(storage.complete).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
  expect(fingerprint).not.toHaveBeenCalled();
};

const expectRejected = async (subject: Prepared) => {
  await expect(subject.invoke()).rejects.toMatchObject({ status: 400 });
  expectNoIdempotencyWork(subject);
  expect(subject.next.handleSpy).not.toHaveBeenCalled();
};

const expectConfigurationError = async (subject: Prepared) => {
  const error: unknown = await subject.invoke().then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(BadRequestException);
  expectNoIdempotencyWork(subject);
  expect(subject.next.handleSpy).not.toHaveBeenCalled();
};

const invalidKeys: Array<[string, unknown]> = [
  ['empty string', ''],
  ['spaces only', '   '],
  ['Unicode whitespace only', '\u00a0\u2003'],
  ['null', null],
  ['zero', 0],
  ['number', 123],
  ['false', false],
  ['true', true],
  ['empty array', []],
  ['single-element array', ['K']],
  ['multiple-element array', ['K', 'L']],
  ['object', { key: 'K' }],
  ['boxed string', new String('K')],
  ['NUL', 'a\u0000b'],
  ['tab', 'a\tb'],
  ['line feed', 'a\nb'],
  ['carriage return', 'a\rb'],
  ['end of C0 range', 'a\u001fb'],
  ['DEL', 'a\u007fb'],
  ['start of C1 range', 'a\u0080b'],
  ['end of C1 range', 'a\u009fb'],
  ['unpaired high surrogate', 'a\ud800b'],
  ['unpaired low surrogate', 'a\udfffb'],
];

describe('REGRESSION: request key validation', () => {
  describe.each([
    ['required', true],
    ['optional', false],
  ] as const)('%s idempotency', (_label, required) => {
    it.each(invalidKeys)('rejects a header containing %s', async (_name, key) => {
      await expectRejected(prepare({ key, metadata: { required } }));
    });

    it.each(invalidKeys)('rejects an asynchronous resolver returning %s', async (_name, key) => {
      await expectRejected(
        prepare({
          options: { keyResolver: async () => key },
          metadata: { required },
        }),
      );
    });
  });

  it.each(['header', 'resolver'])('requires a missing %s key', async (source) => {
    await expectRejected(
      prepare({
        request: { headers: {} },
        options: source === 'resolver' ? { keyResolver: () => undefined } : {},
      }),
    );
  });

  it.each(['header', 'resolver'])(
    'bypasses optional idempotency only for a missing %s key',
    async (source) => {
      const subject = prepare({
        metadata: { required: false },
        request: { headers: {} },
        options: source === 'resolver' ? { keyResolver: async () => undefined } : {},
      });
      await expect(subject.invoke()).resolves.toEqual({ ok: true });
      expectNoIdempotencyWork(subject);
      expect(subject.next.handleSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['K,L', 'K, L', '"K,L"'])('rejects a comma in the raw header %p', async (key) => {
    await expectRejected(prepare({ key }));
  });

  it.each(['Express', 'Fastify'])(
    'rejects duplicate header fields in %s even when merged headers retain one value',
    async (adapter) => {
      const rawHeaders = [
        'Content-Type',
        'application/json',
        'Idempotency-Key',
        'K',
        'IDEMPOTENCY-KEY',
        'K',
      ];
      await expectRejected(
        prepare({
          request: adapter === 'Express' ? { rawHeaders } : { raw: { rawHeaders } },
        }),
      );
    },
  );

  it('detects duplicates using the configured header name case-insensitively', async () => {
    await expectRejected(
      prepare({
        options: { headerName: 'X-Operation-Key' },
        request: {
          headers: { 'x-operation-key': 'K' },
          rawHeaders: ['X-Operation-Key', 'K', 'x-OPERATION-key', 'L'],
        },
      }),
    );
  });

  it('reads a single configured header and ignores unrelated repeated fields', async () => {
    const subject = prepare({
      options: { headerName: 'X-Operation-Key' },
      request: {
        headers: { 'x-operation-key': 'K' },
        rawHeaders: [
          'X-Operation-Key',
          'K',
          'Idempotency-Key',
          'other',
          'Idempotency-Key',
          'other',
        ],
      },
    });
    await expect(subject.invoke()).resolves.toEqual({ ok: true });
    expect(subject.fingerprint).toHaveBeenCalledWith(expect.objectContaining({ key: 'K' }));
  });

  it('allows resolver commas and ignores all unused header ambiguity', async () => {
    const subject = prepare({
      key: ['bad', 'headers'],
      options: { keyResolver: async () => 'event,a,b' },
      request: {
        rawHeaders: ['Idempotency-Key', 'bad', 'Idempotency-Key', 'headers'],
      },
    });
    await expect(subject.invoke()).resolves.toEqual({ ok: true });
    expect(subject.fingerprint).toHaveBeenCalledWith(expect.objectContaining({ key: 'event,a,b' }));
  });

  it.each([false, true])('propagates resolver failures (async: %s)', async (async) => {
    const failure = new Error('signature validation failed');
    const keyResolver = async
      ? () => Promise.reject(failure)
      : () => {
          throw failure;
        };
    const subject = prepare({ options: { keyResolver } });
    await expect(subject.invoke()).rejects.toBe(failure);
    expectNoIdempotencyWork(subject);
    expect(subject.next.handleSpy).not.toHaveBeenCalled();
  });

  it.each([' K ', 'CaseSensitive', 'casesensitive', 'é', 'e\u0301', '🔑', '"K"'])(
    'preserves the exact accepted opaque string %p for fingerprinting',
    async (key) => {
      const subject = prepare({ key });
      await expect(subject.invoke()).resolves.toEqual({ ok: true });
      expect(subject.fingerprint).toHaveBeenCalledWith(expect.objectContaining({ key }));
      expect(subject.next.handleSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['K', ' K '],
    ['K', 'k'],
    ['é', 'e\u0301'],
    ['K', '"K"'],
  ])('isolates %p and %p through actual persistence and replay', async (left, right) => {
    const storage = new MemoryStorage();
    const interceptor = new IdempotencyInterceptor(new Reflector(), storage, { storage });
    const handler = () => undefined;
    Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
    const invoke = (key: string, value: string) => {
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/payments',
          headers: { 'idempotency-key': key },
          body: { amount: 100 },
        },
        handler,
      });
      const next = buildCallHandler(of({ operation: value }));
      return { next, response: firstValueFrom(interceptor.intercept(context, next)) };
    };
    try {
      for (const [key, value] of [
        [left, 'left-operation'],
        [right, 'right-operation'],
      ]) {
        const first = invoke(key, value);
        await expect(first.response).resolves.toEqual({ operation: value });
        expect(first.next.handleSpy).toHaveBeenCalledTimes(1);
      }
      for (const [key, value] of [
        [right, 'right-operation'],
        [left, 'left-operation'],
      ]) {
        const retry = invoke(key, 'duplicate');
        await expect(retry.response).resolves.toEqual({ operation: value });
        expect(retry.next.handleSpy).not.toHaveBeenCalled();
      }
    } finally {
      await storage.onModuleDestroy();
    }
  });

  describe('UTF-8 byte limits', () => {
    it.each(['a'.repeat(255), 'é'.repeat(127) + 'a', '🔑'.repeat(63) + 'abc'])(
      'accepts exactly 255 bytes by default',
      async (key) => {
        expect(Buffer.byteLength(key, 'utf8')).toBe(255);
        const subject = prepare({ key });
        await expect(subject.invoke()).resolves.toEqual({ ok: true });
      },
    );

    it.each(['a'.repeat(256), 'é'.repeat(128), '🔑'.repeat(64)])(
      'rejects 256 bytes by default',
      async (key) => {
        expect(Buffer.byteLength(key, 'utf8')).toBe(256);
        await expectRejected(prepare({ key }));
      },
    );

    it('honors a stricter route limit over the module limit', async () => {
      await expectRejected(
        prepare({
          key: 'éé',
          options: { maxKeyLength: 4 },
          metadata: { maxKeyLength: 3 },
        }),
      );
    });

    it('honors a larger route limit over the module limit', async () => {
      const subject = prepare({
        key: 'éé',
        options: { maxKeyLength: 3 },
        metadata: { maxKeyLength: 4 },
      });
      await expect(subject.invoke()).resolves.toEqual({ ok: true });
    });

    it('applies the byte limit to asynchronous custom resolver output', async () => {
      await expectRejected(
        prepare({
          options: { keyResolver: async () => '🔑', maxKeyLength: 3 },
        }),
      );
    });

    describe.each(['module', 'route'])('%s maxKeyLength configuration', (level) => {
      it.each([
        ['zero', 0],
        ['negative', -1],
        ['fractional', 1.5],
        ['NaN', Number.NaN],
        ['positive infinity', Number.POSITIVE_INFINITY],
        ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
        ['string', '255'],
        ['null', null],
      ])('rejects %s before calling the key resolver', async (_name, maxKeyLength) => {
        const keyResolver = jest.fn(() => 'K');
        const subject = prepare({
          options: {
            keyResolver,
            maxKeyLength: level === 'module' ? maxKeyLength : 255,
          },
          metadata: level === 'route' ? { maxKeyLength } : {},
        });
        await expectConfigurationError(subject);
        expect(keyResolver).not.toHaveBeenCalled();
      });
    });
  });

  describe('custom scope configuration', () => {
    it.each([
      ['empty string', ''],
      ['whitespace string', '  '],
      ['undefined', undefined],
      ['null', null],
      ['number', 42],
      ['object', { tenant: 'a' }],
      ['empty component array', []],
      ['sparse component array', new Array(1)],
      ['empty component', ['tenant-a', '']],
      ['whitespace component', ['tenant-a', '\u2003']],
      ['non-string component', ['tenant-a', 1]],
      ['nested component array', [['tenant-a']]],
      ['async string', Promise.resolve('tenant-a')],
      ['async component array', Promise.resolve(['tenant-a', 'user-a'])],
    ])('rejects a scope resolver returning %s', async (_name, scopeValue) => {
      await expectConfigurationError(prepare({ options: { scope: () => scopeValue } }));
    });

    it.each(['tenant', '', 42, null, {}])('rejects an invalid scope setting %p', async (scope) => {
      await expectConfigurationError(prepare({ options: { scope } }));
    });

    it('consumes an accidentally async scope rejection as a configuration error', async () => {
      await expectConfigurationError(
        prepare({
          options: {
            scope: async () => {
              throw new Error('async identity lookup failed');
            },
          },
        }),
      );
      // Let Node report any unhandled rejection before this test completes.
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    it.each([['tenant-a'], [['tenant-a']], [['tenant-a', 'user-a']]])(
      'accepts a synchronous string or component array: %p',
      async (scopeValue) => {
        const subject = prepare({ options: { scope: () => scopeValue } });
        await expect(subject.invoke()).resolves.toEqual({ ok: true });
        expect(subject.next.handleSpy).toHaveBeenCalledTimes(1);
      },
    );
  });
});
