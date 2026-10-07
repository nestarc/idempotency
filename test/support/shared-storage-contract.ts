/**
 * Shared storage contract test suite.
 *
 * Every built-in and custom `IdempotencyStorage` implementation is expected
 * to pass this suite. It encodes the *behavioral* guarantees of the
 * interface — things the TypeScript type checker cannot enforce:
 *
 *   1. `get()` on a missing key returns `null`.
 *   2. `create()` returns a token and yields a PROCESSING record.
 *   3. A second `create()` for the same key returns `acquired: false`
 *      and does not clobber the original record (NX semantics).
 *   4. `complete()` with a matching token transitions PROCESSING → COMPLETED
 *      and persists statusCode + body + headers.
 *   5. `complete()` with a wrong token returns `'stale'` and does NOT mutate.
 *   6. `complete()` preserves `createdAt` (invariant field).
 *   7. `delete()` with a matching token removes the record.
 *   8. `delete()` with a wrong token returns `'stale'` and does NOT remove.
 *   9. `delete()` on a missing key returns `'ok'` (idempotent cleanup).
 *  10. `complete()` refreshes `expiresAt` to the new TTL window.
 *  11. Response bodies round-trip as opaque strings, including non-JSON encodings.
 *  12. Expired records are logically absent without timer/sweep cleanup.
 *  13. Complete is an atomic, once-only PROCESSING -> COMPLETED transition.
 *  14. Replacement records are unchanged by an expired owner's completion/cleanup.
 *  15. TTLs are safe integer seconds in [1, 2_147_483_647], including long TTLs.
 *  16. Invalid TTLs reject with RangeError before reading or changing records.
 *
 * Plug a new adapter into the suite via `describeStorageContract('Name', factory)`
 * inside that adapter's spec file. Any behavioral drift between adapters will
 * be caught immediately.
 */
import type { IdempotencyStorage } from '../../src/interfaces/idempotency-storage.interface';

export interface StorageHarness {
  storage: IdempotencyStorage;
  /** Expire a key using the adapter's clock without calling its get/delete API. */
  expire: (key: string) => Promise<void>;
  /** Tear down any resources owned by the harness (timers, clients). */
  cleanup: () => Promise<void>;
}

export type StorageFactory = () => Promise<StorageHarness>;

export const describeStorageContract = (name: string, factory: StorageFactory): void => {
  describe(`${name} (shared contract)`, () => {
    let storage: IdempotencyStorage;
    let cleanup: (() => Promise<void>) | undefined;
    let expire: StorageHarness['expire'];

    beforeEach(async () => {
      cleanup = undefined;
      const harness = await factory();
      storage = harness.storage;
      cleanup = harness.cleanup;
      expire = harness.expire;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it('get() on a missing key returns null', async () => {
      await expect(storage.get('missing')).resolves.toBeNull();
    });

    it('create() returns a token and yields a PROCESSING record', async () => {
      const result = await storage.create('contract-1', 'fp', 60);
      expect(result.acquired).toBe(true);
      expect(typeof result.token).toBe('string');

      const record = await storage.get('contract-1');
      expect(record).not.toBeNull();
      expect(record!.token).toBe(result.token);
      expect(record!.status).toBe('PROCESSING');
      expect(record!.fingerprint).toBe('fp');
    });

    it.each([
      ['minimum', 1],
      ['30 days', 30 * 24 * 60 * 60],
      ['maximum', 2_147_483_647],
    ] as const)('create and complete accept the %s TTL', async (_label, ttlSeconds) => {
      const beforeCreate = Date.now();
      const { token } = await storage.create('contract-ttl-range', 'fp', ttlSeconds);
      const afterCreate = Date.now();
      expect(token).toEqual(expect.any(String));
      const original = await storage.get('contract-ttl-range');
      expect(original).not.toBeNull();
      const originalCreatedAt = original!.createdAt.getTime();
      // PostgreSQL uses its server clock; allow 1 second of clock skew. Redis
      // metadata uses the client clock and its server PTTL is tested separately.
      expect(original!.expiresAt.getTime()).toBeGreaterThanOrEqual(
        beforeCreate + ttlSeconds * 1000 - 1000,
      );
      expect(original!.expiresAt.getTime()).toBeLessThanOrEqual(
        afterCreate + ttlSeconds * 1000 + 1000,
      );

      const beforeComplete = Date.now();
      await expect(
        storage.complete(
          'contract-ttl-range',
          token!,
          { statusCode: 201, body: 'long' },
          ttlSeconds,
        ),
      ).resolves.toBe('ok');
      const afterComplete = Date.now();
      const completed = await storage.get('contract-ttl-range');
      expect(completed!.status).toBe('COMPLETED');
      expect(completed!.responseBody).toBe('long');
      expect(completed!.createdAt.getTime()).toBe(originalCreatedAt);
      expect(completed!.expiresAt.getTime()).toBeGreaterThanOrEqual(
        beforeComplete + ttlSeconds * 1000 - 1000,
      );
      expect(completed!.expiresAt.getTime()).toBeLessThanOrEqual(
        afterComplete + ttlSeconds * 1000 + 1000,
      );
    });

    const invalidTtls: Array<[string, unknown]> = [
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
      ['above maximum', 2_147_483_648],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['numeric string', '60'],
      ['null', null],
      ['undefined', undefined],
      ['boolean', true],
      ['object', {}],
      ['object without a prototype', Object.create(null)],
      [
        'object with throwing toString',
        {
          toString: () => {
            throw new Error('Invalid TTL must not invoke object coercion');
          },
        },
      ],
      [
        'function with throwing toString',
        Object.assign(() => undefined, {
          toString: () => {
            throw new Error('Invalid TTL must not invoke function coercion');
          },
        }),
      ],
    ];

    it.each(invalidTtls)(
      'create and complete reject %s TTL without mutation',
      async (_label, ttl) => {
        await expect(storage.create('contract-invalid-new', 'fp', ttl as number)).rejects.toThrow(
          RangeError,
        );
        await expect(storage.get('contract-invalid-new')).resolves.toBeNull();

        const { token } = await storage.create('contract-invalid-complete', 'fp', 60);
        const before = structuredClone(await storage.get('contract-invalid-complete'));
        await expect(
          storage.complete(
            'contract-invalid-complete',
            token!,
            { statusCode: 201, body: 'invalid', headers: { location: '/invalid' } },
            ttl as number,
          ),
        ).rejects.toThrow(RangeError);
        expect(await storage.get('contract-invalid-complete')).toEqual(before);
      },
    );

    it.each(['missing', 'processing', 'wrong-token', 'completed', 'expired', 'replaced'] as const)(
      'invalid TTL rejects before create/complete state checks for %s records',
      async (state) => {
        const key = 'contract-invalid-state';
        let token = '00000000-0000-4000-8000-000000000000';
        let before = null;
        if (state !== 'missing') {
          token = (await storage.create(key, 'fp', 60)).token!;
          if (state === 'completed') {
            await storage.complete(key, token, { statusCode: 201, body: 'first' }, 60);
          }
          if (state === 'expired' || state === 'replaced') {
            await expire(key);
          }
          if (state === 'replaced') {
            await storage.create(key, 'replacement', 60);
          }
          if (state === 'wrong-token') token = '00000000-0000-4000-8000-000000000000';
          // Do not read an expired record before exercising invalid input:
          // adapter get() may perform cleanup and conceal early state checks.
          if (state !== 'expired') before = structuredClone(await storage.get(key));
        }

        await expect(storage.create(key, 'invalid', 0)).rejects.toThrow(RangeError);
        await expect(
          storage.complete(key, token, { statusCode: 500, body: 'invalid' }, 0),
        ).rejects.toThrow(RangeError);
        expect(await storage.get(key)).toEqual(before);
      },
    );

    it('a second create() on the same key returns acquired=false without clobbering', async () => {
      const first = await storage.create('contract-2', 'fpA', 60);
      const second = await storage.create('contract-2', 'fpB', 60);
      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      expect(second.token).toBeUndefined();

      const record = await storage.get('contract-2');
      expect(record!.fingerprint).toBe('fpA');
      expect(record!.token).toBe(first.token);
    });

    it('concurrent creates have exactly one winner with its own fingerprint', async () => {
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((fingerprint) =>
          storage.create('contract-concurrent', fingerprint, 60),
        ),
      );
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      expect(results.filter((result) => !result.acquired)).toEqual([
        { acquired: false },
        { acquired: false },
        { acquired: false },
      ]);
      const winnerIndex = results.findIndex((result) => result.acquired);
      const record = await storage.get('contract-concurrent');
      expect(record!.token).toBe(results[winnerIndex].token);
      expect(record!.fingerprint).toBe(['a', 'b', 'c', 'd'][winnerIndex]);
    });

    it('repeated complete is stale and preserves the first response, TTL and createdAt', async () => {
      const { token } = await storage.create('contract-repeat', 'fp', 60);
      await expect(
        storage.complete(
          'contract-repeat',
          token!,
          {
            statusCode: 201,
            body: 'first',
            headers: { location: '/first' },
          },
          60,
        ),
      ).resolves.toBe('ok');
      const first = structuredClone(await storage.get('contract-repeat'));
      await expect(
        storage.complete(
          'contract-repeat',
          token!,
          {
            statusCode: 202,
            body: 'second',
            headers: { location: '/second' },
          },
          3600,
        ),
      ).resolves.toBe('stale');
      expect(await storage.get('contract-repeat')).toEqual(first);
    });

    it('concurrent completions with the same token have exactly one response winner', async () => {
      const { token } = await storage.create('contract-complete-race', 'fp', 60);
      const results = await Promise.all([
        storage.complete('contract-complete-race', token!, { statusCode: 201, body: 'one' }, 60),
        storage.complete('contract-complete-race', token!, { statusCode: 202, body: 'two' }, 3600),
      ]);
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'stale')).toHaveLength(1);
      const winner = results.findIndex((result) => result === 'ok');
      const record = await storage.get('contract-complete-race');
      expect(record!.responseBody).toBe(winner === 0 ? 'one' : 'two');
      expect(record!.statusCode).toBe(winner === 0 ? 201 : 202);
    });

    it('an expired lease cannot complete even when no replacement exists', async () => {
      const { token } = await storage.create('contract-expired-complete', 'fp', 60);
      await expire('contract-expired-complete');
      await expect(
        storage.complete(
          'contract-expired-complete',
          token!,
          {
            statusCode: 201,
            body: 'late',
          },
          3600,
        ),
      ).resolves.toBe('stale');
      await expect(storage.get('contract-expired-complete')).resolves.toBeNull();
    });

    it.each(['PROCESSING', 'COMPLETED'] as const)(
      'an expired %s record is absent for get and delete, including a different token',
      async (status) => {
        const { token } = await storage.create('contract-expired-delete', 'fp', 60);
        if (status === 'COMPLETED') {
          await storage.complete('contract-expired-delete', token!, { statusCode: 200 }, 60);
        }
        await expire('contract-expired-delete');
        // Delete first: get must not accidentally perform the expiry cleanup.
        await expect(storage.delete('contract-expired-delete', 'wrong-token')).resolves.toBe('ok');
        await expect(storage.get('contract-expired-delete')).resolves.toBeNull();
      },
    );

    it.each(['PROCESSING', 'COMPLETED'] as const)(
      'an expired %s record can be replaced and its old token cannot modify the new record',
      async (status) => {
        const old = await storage.create('contract-replace', 'old', 60);
        if (status === 'COMPLETED') {
          await storage.complete(
            'contract-replace',
            old.token!,
            { statusCode: 200, body: 'old' },
            60,
          );
        }
        await expire('contract-replace');
        const replacement = await storage.create('contract-replace', 'new', 120);
        expect(replacement.acquired).toBe(true);
        expect(replacement.token).not.toBe(old.token);
        const before = structuredClone(await storage.get('contract-replace'));
        expect(before!.status).toBe('PROCESSING');
        expect(before!.responseBody).toBeUndefined();
        await expect(
          storage.complete(
            'contract-replace',
            old.token!,
            {
              statusCode: 201,
              body: 'late',
              headers: { location: '/late' },
            },
            3600,
          ),
        ).resolves.toBe('stale');
        await expect(storage.delete('contract-replace', old.token!)).resolves.toBe('stale');
        expect(await storage.get('contract-replace')).toEqual(before);
      },
    );

    it('complete() with a matching token transitions to COMPLETED', async () => {
      const { token } = await storage.create('contract-3', 'fp', 60);
      const result = await storage.complete(
        'contract-3',
        token!,
        { statusCode: 201, body: '{"id":"xyz"}' },
        3600,
      );
      expect(result).toBe('ok');

      const record = await storage.get('contract-3');
      expect(record!.status).toBe('COMPLETED');
      expect(record!.statusCode).toBe(201);
      expect(record!.responseBody).toBe('{"id":"xyz"}');
    });

    it('round-trips opaque response strings without interpreting their encoding', async () => {
      const body = '@nestarc/idempotency:replay:v1:{"kind":"undefined"}';
      const { token } = await storage.create('contract-opaque-body', 'fp', 60);
      await expect(
        storage.complete('contract-opaque-body', token!, { statusCode: 204, body }, 60),
      ).resolves.toBe('ok');
      expect((await storage.get('contract-opaque-body'))!.responseBody).toBe(body);
    });

    it('complete() snapshots response headers for replay', async () => {
      const headers: Record<string, string> = {
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
      };
      const { token } = await storage.create('contract-headers', 'fp', 60);
      const result = await storage.complete(
        'contract-headers',
        token!,
        { statusCode: 201, body: '{"id":"xyz"}', headers },
        3600,
      );
      expect(result).toBe('ok');

      headers.location = '/mutated';
      headers['x-added-after-complete'] = 'too-late';

      const record = await storage.get('contract-headers');
      expect(record!.responseHeaders).toEqual({
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
      });
    });

    // Both malformed and well-formed nonmatching tokens must retain the same
    // CAS behavior when an adapter loads its driver's error class lazily.
    it.each(['wrong-token', '00000000-0000-4000-8000-000000000000'])(
      'complete() with nonmatching token %s returns "stale" and does not mutate',
      async (wrongToken) => {
        await storage.create('contract-4', 'fp', 60);
        const before = structuredClone(await storage.get('contract-4'));
        const result = await storage.complete(
          'contract-4',
          wrongToken,
          { statusCode: 200, body: '{}' },
          60,
        );
        expect(result).toBe('stale');

        expect(await storage.get('contract-4')).toEqual(before);
      },
    );

    // This is the LSP-level invariant that caught adapter drift.
    it('complete() preserves createdAt (invariant field)', async () => {
      const { token } = await storage.create('contract-5', 'fp', 60);
      const original = await storage.get('contract-5');
      const originalCreatedAt = original!.createdAt.getTime();

      // Ensure the clock has ticked so a naive "createdAt = now" would diverge.
      await new Promise((r) => setTimeout(r, 5));

      await storage.complete('contract-5', token!, { statusCode: 200, body: '{}' }, 3600);
      const completed = await storage.get('contract-5');
      expect(completed!.createdAt.getTime()).toBe(originalCreatedAt);
    });

    it('complete() refreshes expiresAt to the new TTL window', async () => {
      const { token } = await storage.create('contract-6', 'fp', 10);
      const beforeComplete = Date.now();
      await storage.complete('contract-6', token!, { statusCode: 200, body: '{}' }, 3600);
      const completed = await storage.get('contract-6');
      const expiresAtMs = completed!.expiresAt.getTime();
      // expiresAt should be approximately now + 3600s, not original + 10s.
      expect(expiresAtMs).toBeGreaterThanOrEqual(beforeComplete + 3599 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(beforeComplete + 3601 * 1000);
    });

    it('delete() with a matching token removes the record', async () => {
      const { token } = await storage.create('contract-7', 'fp', 60);
      const result = await storage.delete('contract-7', token!);
      expect(result).toBe('ok');
      await expect(storage.get('contract-7')).resolves.toBeNull();
    });

    it.each(['wrong-token', '00000000-0000-4000-8000-000000000000'])(
      'delete() with nonmatching token %s returns "stale" and leaves the record intact',
      async (wrongToken) => {
        await storage.create('contract-8', 'fp', 60);
        const before = structuredClone(await storage.get('contract-8'));
        const result = await storage.delete('contract-8', wrongToken);
        expect(result).toBe('stale');
        expect(await storage.get('contract-8')).toEqual(before);
      },
    );

    it('a completed record blocks a new owner without changing its replay or retention', async () => {
      const { token } = await storage.create('contract-completed-nx', undefined, 60);
      await expect(
        storage.complete(
          'contract-completed-nx',
          token!,
          {
            statusCode: 204,
            body: '',
            headers: { 'x-replay': 'original' },
          },
          120,
        ),
      ).resolves.toBe('ok');
      const before = structuredClone(await storage.get('contract-completed-nx'));
      expect(before!.fingerprint).toBeUndefined();
      expect(before!.responseBody).toBe('');

      await expect(storage.create('contract-completed-nx', 'replacement', 3600)).resolves.toEqual({
        acquired: false,
      });
      await expect(
        storage.delete('contract-completed-nx', '00000000-0000-4000-8000-000000000000'),
      ).resolves.toBe('stale');
      expect(await storage.get('contract-completed-nx')).toEqual(before);
      await expect(storage.delete('contract-completed-nx', token!)).resolves.toBe('ok');
      await expect(storage.get('contract-completed-nx')).resolves.toBeNull();
    });

    it('a valid owner token for a different key cannot complete or delete this lease', async () => {
      const first = await storage.create('contract-owner-a', 'a', 60);
      const second = await storage.create('contract-owner-b', 'b', 60);
      expect(first.token).not.toBe(second.token);
      const beforeA = structuredClone(await storage.get('contract-owner-a'));
      const beforeB = structuredClone(await storage.get('contract-owner-b'));

      await expect(
        storage.complete(
          'contract-owner-b',
          first.token!,
          {
            statusCode: 201,
            body: 'wrong owner',
          },
          3600,
        ),
      ).resolves.toBe('stale');
      await expect(storage.delete('contract-owner-b', first.token!)).resolves.toBe('stale');
      expect(await storage.get('contract-owner-a')).toEqual(beforeA);
      expect(await storage.get('contract-owner-b')).toEqual(beforeB);
    });

    it('delete() on a missing key returns "ok" (idempotent cleanup)', async () => {
      const result = await storage.delete('contract-missing', 'any-token');
      expect(result).toBe('ok');
    });
  });
};
