# v0.3.0 Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.3.0 as a reliability release: actual-path endpoint scoping, stable JSON fingerprinting, response header replay, Fastify verification, and CI/release hardening.

**Architecture:** Keep the public module/decorator/storage model intact. Extract three private helper boundaries from `IdempotencyInterceptor`: request scope resolution, deterministic JSON serialization, and response header capture/replay. Extend the existing storage contract and each adapter to persist optional response headers while preserving token-CAS behavior.

**Tech Stack:** NestJS 10/11, TypeScript 5.4, Jest 29, RxJS 7, Express, Fastify via `@nestjs/platform-fastify`, Redis via `ioredis`, Postgres 12+ via `pg`.

---

## File Structure

**Created files:**

- `src/utils/stable-json.ts` - deterministic JSON serializer used by request fingerprinting.
- `src/utils/request-scope.ts` - actual request path extraction and normalization for endpoint scope.
- `src/utils/response-headers.ts` - header replay policy, capture, and restore helpers.
- `test/utils/stable-json.spec.ts` - serializer unit coverage.
- `test/utils/request-scope.spec.ts` - path/query normalization coverage.
- `test/utils/response-headers.spec.ts` - allowlist, denylist, and replay helper coverage.
- `test/e2e/fastify.e2e-spec.ts` - Fastify adapter e2e coverage.
- `test/storage/redis.storage.real.spec.ts` - real Redis smoke/contract coverage gated by `TEST_REDIS_URL`.

**Modified files:**

- `package.json` - add Fastify dev dependency and `test:redis` script.
- `package-lock.json` - sync dependency graph.
- `src/idempotency.interceptor.ts` - use new helpers, capture/replay headers, stable fingerprinting, actual request path scoping.
- `src/interfaces/idempotency-options.interface.ts` - add `replayHeaders?: boolean | string[]`.
- `src/interfaces/idempotency-record.interface.ts` - add `responseHeaders?: Record<string, string>`.
- `src/interfaces/idempotency-storage.interface.ts` - add `headers?: Record<string, string>` to `CompleteResponse`.
- `src/storage/memory.storage.ts` - persist response headers.
- `src/storage/redis.storage.ts` - serialize/deserialize response headers.
- `src/storage/postgres.storage.ts` - persist `response_headers JSONB`.
- `src/index.ts` - export any new public option type if introduced.
- `sql/init.sql` - include `response_headers JSONB`.
- `test/support/execution-context.factory.ts` - extend fake request/response shape with URL/header helpers.
- `test/support/fake-storage.ts` - persist response headers in the test double.
- `test/support/shared-storage-contract.ts` - assert response header persistence.
- Existing interceptor/e2e/storage specs - add regression coverage.
- `.github/workflows/ci.yml` - add real Redis smoke job and Fastify v10 matrix override.
- `.github/workflows/release.yml` - add Postgres service and `TEST_DATABASE_URL` to prepublish.
- `README.md` - document v0.3.0 behavior and migration.
- `CHANGELOG.md` - add v0.3.0 entry.

---

### Task 1: Add Fastify and Real Redis Test Wiring

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the package script and dev dependency**

Edit `package.json` so the `scripts` block includes:

```json
"test:redis": "jest --selectProjects unit --runInBand test/storage/redis.storage.real.spec.ts"
```

Add this dev dependency next to the other Nest packages:

```json
"@nestjs/platform-fastify": "^11.0.0"
```

- [ ] **Step 2: Install and sync the lockfile**

Run:

```powershell
npm install
```

Expected: exit code 0, `package-lock.json` updated.

- [ ] **Step 3: Verify the new script is registered**

Run:

```powershell
npm pkg get scripts.test:redis --workspaces=false
```

Expected output:

```text
"jest --selectProjects unit --runInBand test/storage/redis.storage.real.spec.ts"
```

- [ ] **Step 4: Commit dependency wiring**

```bash
git add package.json package-lock.json
git commit -m "test: add fastify and redis smoke test wiring"
```

---

### Task 2: Add Deterministic JSON Serializer

**Files:**
- Create: `src/utils/stable-json.ts`
- Create: `test/utils/stable-json.spec.ts`
- Modify: `src/idempotency.interceptor.ts`
- Modify: `test/idempotency.interceptor.spec.ts`

- [ ] **Step 1: Write serializer tests**

Create `test/utils/stable-json.spec.ts`:

```ts
import { stableJsonStringify } from '../../src/utils/stable-json';

describe('stableJsonStringify', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const a = { z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }] };
    const b = { list: [{ x: 1, y: 2 }], a: { b: 2, d: 4 }, z: 1 };

    expect(stableJsonStringify(a)).toBe(stableJsonStringify(b));
    expect(stableJsonStringify(a)).toBe(
      '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2}],"z":1}',
    );
  });

  it('matches JSON.stringify behavior for nullish and primitive values', () => {
    expect(stableJsonStringify(undefined)).toBe(undefined);
    expect(stableJsonStringify(null)).toBe('null');
    expect(stableJsonStringify('x')).toBe('"x"');
    expect(stableJsonStringify(3)).toBe('3');
    expect(stableJsonStringify(true)).toBe('true');
  });

  it('preserves JSON array treatment for undefined values', () => {
    expect(stableJsonStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('omits undefined object properties like JSON.stringify', () => {
    expect(stableJsonStringify({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  it('throws on circular structures', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;

    expect(() => stableJsonStringify(value)).toThrow(/circular/i);
  });

  it('throws on BigInt values like JSON.stringify', () => {
    expect(() => stableJsonStringify({ value: BigInt(1) })).toThrow();
  });
});
```

- [ ] **Step 2: Run serializer tests and confirm failure**

Run:

```powershell
npm test -- test/utils/stable-json.spec.ts --runInBand
```

Expected: FAIL because `src/utils/stable-json.ts` does not exist.

- [ ] **Step 3: Implement the serializer**

Create `src/utils/stable-json.ts`:

```ts
type JsonLike =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonLike[]
  | { [key: string]: JsonLike };

export function stableJsonStringify(value: unknown): string | undefined {
  return JSON.stringify(sortJsonValue(value, new WeakSet<object>()));
}

function sortJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === 'function') {
    return sortJsonValue(
      (withToJson.toJSON as () => JsonLike)(),
      seen,
    );
  }

  if (seen.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const sorted = value.map((item) => sortJsonValue(item, seen));
    seen.delete(value);
    return sorted;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = sortJsonValue(input[key], seen);
  }
  seen.delete(value);
  return output;
}
```

- [ ] **Step 4: Run serializer tests and confirm pass**

Run:

```powershell
npm test -- test/utils/stable-json.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Add interceptor regression test for stable fingerprints**

In `test/idempotency.interceptor.spec.ts`, update the local `sha256` helper:

```ts
import { stableJsonStringify } from '../src/utils/stable-json';

const sha256 = (input: unknown): string =>
  createHash('sha256')
    .update(stableJsonStringify(input ?? null)!)
    .digest('hex');
```

Add this test inside `describe('E. fingerprint mismatch', ...)`:

```ts
it('treats object key order differences as the same fingerprint', async () => {
  const { interceptor, storage } = buildInterceptor();
  storage.seed({
    key: 'K-stable',
    fingerprint: sha256({ b: 2, a: { d: 4, c: 3 } }),
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
      body: { a: { c: 3, d: 4 }, b: 2 },
    },
    res,
    handler,
  });
  const next = buildCallHandler();

  const result = await firstValueFrom(interceptor.intercept(context, next));

  expect(result).toEqual({ ok: true });
  expect(next.handleSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run the interceptor regression and confirm failure**

Run:

```powershell
npm test -- test/idempotency.interceptor.spec.ts --runInBand
```

Expected: FAIL on the new stable fingerprint test because the interceptor still uses insertion-order `JSON.stringify`.

- [ ] **Step 7: Use stable serializer in the interceptor**

In `src/idempotency.interceptor.ts`, add:

```ts
import { stableJsonStringify } from './utils/stable-json';
```

Replace `computeFingerprint` with:

```ts
  private computeFingerprint(body: unknown): string {
    return createHash('sha256')
      .update(stableJsonStringify(body ?? null)!)
      .digest('hex');
  }
```

- [ ] **Step 8: Run targeted tests**

Run:

```powershell
npm test -- test/utils/stable-json.spec.ts test/idempotency.interceptor.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 9: Commit stable fingerprinting**

```bash
git add src/utils/stable-json.ts test/utils/stable-json.spec.ts src/idempotency.interceptor.ts test/idempotency.interceptor.spec.ts
git commit -m "fix: make request fingerprints stable"
```

---

### Task 3: Add Actual Request Path Endpoint Scoping

**Files:**
- Create: `src/utils/request-scope.ts`
- Create: `test/utils/request-scope.spec.ts`
- Modify: `test/support/execution-context.factory.ts`
- Modify: `src/idempotency.interceptor.ts`
- Modify: `test/idempotency.interceptor.spec.ts`
- Modify: `test/e2e/idempotency.e2e-spec.ts`

- [ ] **Step 1: Write path helper tests**

Create `test/utils/request-scope.spec.ts`:

```ts
import {
  extractActualRequestPath,
  normalizeHttpPath,
} from '../../src/utils/request-scope';

describe('request-scope helpers', () => {
  it('uses Express originalUrl without query string', () => {
    expect(
      extractActualRequestPath({
        originalUrl: '/orders/123/capture?verbose=true',
        url: '/orders/:id/capture',
      }),
    ).toBe('/orders/123/capture');
  });

  it('uses Fastify url without query string when originalUrl is absent', () => {
    expect(
      extractActualRequestPath({
        url: '/orders/456/capture?verbose=true',
      }),
    ).toBe('/orders/456/capture');
  });

  it('normalizes duplicate and trailing slashes', () => {
    expect(normalizeHttpPath('orders//123/capture/')).toBe(
      '/orders/123/capture',
    );
  });

  it('keeps root path stable', () => {
    expect(normalizeHttpPath('/?a=1')).toBe('/');
  });
});
```

- [ ] **Step 2: Run path helper tests and confirm failure**

Run:

```powershell
npm test -- test/utils/request-scope.spec.ts --runInBand
```

Expected: FAIL because `src/utils/request-scope.ts` does not exist.

- [ ] **Step 3: Implement path helpers**

Create `src/utils/request-scope.ts`:

```ts
export interface RequestScopeSource {
  originalUrl?: string;
  url?: string;
}

export function extractActualRequestPath(
  req: RequestScopeSource | undefined,
): string | undefined {
  const raw = req?.originalUrl ?? req?.url;
  if (!raw) return undefined;
  return normalizeHttpPath(raw);
}

export function normalizeHttpPath(raw: string): string {
  const withoutQuery = raw.split('?')[0] ?? '';
  const withLeadingSlash = withoutQuery.startsWith('/')
    ? withoutQuery
    : `/${withoutQuery}`;
  const normalized = withLeadingSlash
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}
```

- [ ] **Step 4: Run path helper tests and confirm pass**

Run:

```powershell
npm test -- test/utils/request-scope.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Extend the fake request shape**

In `test/support/execution-context.factory.ts`, change `FakeRequest` to:

```ts
export interface FakeRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: unknown;
  originalUrl?: string;
  url?: string;
}
```

- [ ] **Step 6: Add interceptor scope regression tests**

In `test/idempotency.interceptor.spec.ts`, inside `describe('J. scope (P1 #2 regression)', ...)`, replace the old expectation in `scope=endpoint prefixes storage keys with ClassName#methodName::` with an actual-path expectation:

```ts
it('scope=endpoint prefixes storage keys with method and actual request path', async () => {
  const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });
  const handler = decoratedHandler({ enabled: true });
  const { context } = buildExecutionContext({
    req: {
      method: 'POST',
      originalUrl: '/orders/123/capture?verbose=true',
      url: '/orders/123/capture?verbose=true',
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
```

Add this second test in the same block:

```ts
it('same route template with different path params uses different scoped keys', async () => {
  const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });
  const handler = decoratedHandler({ enabled: true });

  await firstValueFrom(
    interceptor.intercept(
      buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/orders/1/capture',
          headers: { 'idempotency-key': 'same-key' },
          body: { amount: 10 },
        },
        handler,
        controller: PaymentsController,
      }).context,
      buildCallHandler(of({ id: 'one' })),
    ),
  );

  await firstValueFrom(
    interceptor.intercept(
      buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/orders/2/capture',
          headers: { 'idempotency-key': 'same-key' },
          body: { amount: 10 },
        },
        handler,
        controller: PaymentsController,
      }).context,
      buildCallHandler(of({ id: 'two' })),
    ),
  );

  const keys = storage.create.mock.calls.map(([key]) => key);
  expect(keys).toContain('POST /orders/1/capture::same-key');
  expect(keys).toContain('POST /orders/2/capture::same-key');
});
```

Add this third test:

```ts
it('query strings are ignored by default endpoint scope', async () => {
  const { interceptor, storage } = buildInterceptor({ scope: 'endpoint' });
  const handler = decoratedHandler({ enabled: true });

  await firstValueFrom(
    interceptor.intercept(
      buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/search?a=1',
          headers: { 'idempotency-key': 'query-key' },
          body: { q: 'x' },
        },
        handler,
      }).context,
      buildCallHandler(of({ first: true })),
    ),
  );

  await firstValueFrom(
    interceptor.intercept(
      buildExecutionContext({
        req: {
          method: 'POST',
          originalUrl: '/search?b=2',
          headers: { 'idempotency-key': 'query-key' },
          body: { q: 'x' },
        },
        handler,
      }).context,
      buildCallHandler(of({ second: true })),
    ),
  );

  const createCalls = storage.create.mock.calls.map(([key]) => key);
  expect(createCalls.filter((key) => key === 'POST /search::query-key')).toHaveLength(1);
});
```

- [ ] **Step 7: Run interceptor scope tests and confirm failure**

Run:

```powershell
npm test -- test/idempotency.interceptor.spec.ts --runInBand
```

Expected: FAIL on actual-path expectations because the interceptor still uses Nest path metadata/fallback first.

- [ ] **Step 8: Use actual request path in endpoint scope**

In `src/idempotency.interceptor.ts`, add:

```ts
import { extractActualRequestPath } from './utils/request-scope';
```

Change the request type in `intercept()` to include URL fields:

```ts
    const req = http.getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
    }>();
```

Replace the first part of `computeEndpointScope()` with:

```ts
    const req = context.switchToHttp().getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const httpMethod = (req?.method ?? 'UNKNOWN').toUpperCase();
    const actualPath = extractActualRequestPath(req);
    if (actualPath) {
      return `${httpMethod} ${actualPath}`;
    }
```

Keep the existing Nest metadata fallback after that block.

- [ ] **Step 9: Add Express e2e route-param coverage**

In `test/e2e/idempotency.e2e-spec.ts`, add a counter field:

```ts
const callCounter = { create: 0, refund: 0, fail: 0, cross: 0, capture: 0 };
```

Add a controller method to `PaymentsController`:

```ts
  @Post(':id/capture')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  capture(@Body() dto: { amount: number }) {
    callCounter.capture += 1;
    return {
      id: `cap_${callCounter.capture}`,
      kind: 'capture',
      amount: dto.amount,
    };
  }
```

Reset the new counter in `beforeEach()`:

```ts
    callCounter.capture = 0;
```

Add this e2e test:

```ts
  it('does not conflate parameterized route targets with the same key and body', async () => {
    const first = await request(app.getHttpServer())
      .post('/payments/pay_1/capture')
      .set('Idempotency-Key', 'capture-key')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.body.id).toBe('cap_1');

    const second = await request(app.getHttpServer())
      .post('/payments/pay_2/capture')
      .set('Idempotency-Key', 'capture-key')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body.id).toBe('cap_2');
    expect(callCounter.capture).toBe(2);
  });
```

- [ ] **Step 10: Run targeted tests**

Run:

```powershell
npm test -- test/utils/request-scope.spec.ts test/idempotency.interceptor.spec.ts --runInBand
npm run test:e2e -- test/e2e/idempotency.e2e-spec.ts
```

Expected: PASS.

- [ ] **Step 11: Commit request-path scoping**

```bash
git add src/utils/request-scope.ts test/utils/request-scope.spec.ts test/support/execution-context.factory.ts src/idempotency.interceptor.ts test/idempotency.interceptor.spec.ts test/e2e/idempotency.e2e-spec.ts
git commit -m "fix: scope idempotency keys by actual request path"
```

---

### Task 4: Extend Storage Types and Contract for Response Headers

**Files:**
- Modify: `src/interfaces/idempotency-storage.interface.ts`
- Modify: `src/interfaces/idempotency-record.interface.ts`
- Modify: `test/support/shared-storage-contract.ts`
- Modify: `test/support/fake-storage.ts`
- Modify: `src/storage/memory.storage.ts`
- Modify: `src/storage/redis.storage.ts`
- Modify: `src/storage/postgres.storage.ts`

- [ ] **Step 1: Extend public record and complete response types**

In `src/interfaces/idempotency-storage.interface.ts`, update `CompleteResponse`:

```ts
export interface CompleteResponse {
  /** HTTP status code emitted by the original handler. */
  statusCode: number;

  /** JSON-serialized response body, or undefined for empty bodies (e.g. 204). */
  body?: string;

  /** Lowercase HTTP response headers captured for replay. */
  headers?: Record<string, string>;
}
```

In `src/interfaces/idempotency-record.interface.ts`, add after `responseBody?: string;`:

```ts
  /** Lowercase response headers captured from the original response. */
  responseHeaders?: Record<string, string>;
```

- [ ] **Step 2: Add shared contract coverage**

In `test/support/shared-storage-contract.ts`, add this test after the existing `complete() with a matching token transitions to COMPLETED` test:

```ts
    it('complete() persists replayable response headers', async () => {
      const { token } = await storage.create('contract-headers', 'fp', 60);
      const result = await storage.complete(
        'contract-headers',
        token!,
        {
          statusCode: 201,
          body: '{"id":"xyz"}',
          headers: {
            location: '/payments/pay_1',
            'x-request-id': 'req_1',
          },
        },
        3600,
      );
      expect(result).toBe('ok');

      const record = await storage.get('contract-headers');
      expect(record!.responseHeaders).toEqual({
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
      });
    });
```

- [ ] **Step 3: Run storage contract tests and confirm failure**

Run:

```powershell
npm test -- test/storage/memory.storage.spec.ts test/storage/redis.storage.spec.ts --runInBand
```

Expected: FAIL on the new shared contract test because adapters do not persist headers yet.

- [ ] **Step 4: Update FakeStorage test double**

In `test/support/fake-storage.ts`, update `complete()` record mutation:

```ts
      this.records.set(key, {
        ...existing,
        status: 'COMPLETED',
        statusCode: response.statusCode,
        responseBody: response.body,
        responseHeaders: response.headers,
        createdAt: existing.createdAt,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
```

- [ ] **Step 5: Update MemoryStorage**

In `src/storage/memory.storage.ts`, update the `updated` record in `complete()`:

```ts
    const updated: IdempotencyRecord = {
      ...entry.record,
      status: 'COMPLETED',
      statusCode: response.statusCode,
      responseBody: response.body,
      responseHeaders: response.headers,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
```

- [ ] **Step 6: Update RedisStorage serialization**

In `src/storage/redis.storage.ts`, extend `SerializedPayload`:

```ts
  responseHeaders?: Record<string, string>;
```

In `get()`, include:

```ts
      responseHeaders: payload.responseHeaders,
```

In `complete()`, include:

```ts
      responseHeaders: response.headers,
```

- [ ] **Step 7: Update PostgresStorage object mapping**

In `src/storage/postgres.storage.ts`, update the selected row type in `get()`:

```ts
      response_headers: Record<string, string> | null;
```

Update the SELECT column list:

```sql
response_code, response_body, response_headers,
```

Include the mapped field in the returned record:

```ts
      responseHeaders: row.response_headers ?? undefined,
```

Update `create()` expired-row replacement to clear headers:

```sql
             response_headers = NULL,
```

Update `complete()` to set headers:

```ts
        `UPDATE ${quoteIdent(this.tableName)}
           SET status           = 'COMPLETED',
               response_code    = $3,
               response_body    = $4,
               response_headers = $5,
               expires_at       = now() + ($6 || ' seconds')::interval
           WHERE key = $1 AND token = $2 AND status = 'PROCESSING'`,
        [
          key,
          token,
          response.statusCode,
          response.body ?? null,
          response.headers ?? null,
          String(ttlSeconds),
        ],
```

- [ ] **Step 8: Run non-Postgres storage tests**

Run:

```powershell
npm test -- test/storage/memory.storage.spec.ts test/storage/redis.storage.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 9: Commit storage type changes**

```bash
git add src/interfaces/idempotency-storage.interface.ts src/interfaces/idempotency-record.interface.ts test/support/shared-storage-contract.ts test/support/fake-storage.ts src/storage/memory.storage.ts src/storage/redis.storage.ts src/storage/postgres.storage.ts
git commit -m "feat: persist replayable response headers in storage"
```

---

### Task 5: Add Postgres Header Schema Migration Support

**Files:**
- Modify: `sql/init.sql`
- Modify: `src/storage/postgres.storage.ts`
- Modify: `test/storage/postgres.storage.spec.ts`

- [ ] **Step 1: Update bundled SQL schema**

In `sql/init.sql`, add `response_headers JSONB` after `response_body`:

```sql
  response_body  TEXT,
  response_headers JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
```

- [ ] **Step 2: Update code-driven schema creation**

In `PostgresStorage.createSchema()`, add:

```sql
        response_headers JSONB,
```

after `response_body  TEXT,`.

- [ ] **Step 3: Add Postgres schema assertion**

In `test/storage/postgres.storage.spec.ts`, add this test inside `describeOrSkip('PostgresStorage - Postgres-specific behavior', ...)`:

```ts
  it('createSchema() creates the response_headers JSONB column', async () => {
    await PostgresStorage.createSchema(pool, TABLE_NAME);

    const result = await pool.query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'response_headers'`,
      [TABLE_NAME],
    );

    expect(result.rows[0].data_type).toBe('jsonb');
  });
```

- [ ] **Step 4: Add expired replacement header cleanup assertion**

In the existing `create() replaces an expired row with a fresh PROCESSING record` test, change the seed SQL to insert `response_headers`:

```sql
         (key, token, fingerprint, status, response_code, response_body, response_headers, expires_at)
       VALUES ('expired-key', gen_random_uuid(), 'old-fp', 'COMPLETED',
               200, '{"prior":"body"}', '{"x-old":"1"}'::jsonb, now() - interval '1 second')
```

Add this assertion after `responseBody`:

```ts
    expect(row!.responseHeaders).toBeUndefined();
```

- [ ] **Step 5: Run Postgres tests locally when Postgres is available**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://test:test@localhost:5432/idempotency_test'
npm test -- test/storage/postgres.storage.spec.ts --runInBand
```

Expected with local Postgres running: PASS. Expected without `TEST_DATABASE_URL`: suite prints skip warning.

- [ ] **Step 6: Commit Postgres schema support**

```bash
git add sql/init.sql src/storage/postgres.storage.ts test/storage/postgres.storage.spec.ts
git commit -m "feat: add postgres response header storage"
```

---

### Task 6: Add Response Header Policy Helpers

**Files:**
- Create: `src/utils/response-headers.ts`
- Create: `test/utils/response-headers.spec.ts`
- Modify: `src/interfaces/idempotency-options.interface.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add option type**

In `src/interfaces/idempotency-options.interface.ts`, add before `IdempotencyOptions`:

```ts
export type ReplayHeadersOption = boolean | string[];
```

Add to `IdempotencyOptions`:

```ts
  /**
   * Controls which response headers are captured and replayed.
   *
   * `true` or undefined uses the conservative default allowlist.
   * `false` disables header replay.
   * A string array uses an explicit allowlist, still filtered through the
   * unsafe header denylist.
   *
   * @default true
   */
  replayHeaders?: ReplayHeadersOption;
```

In `src/index.ts`, export the new type:

```ts
  ReplayHeadersOption,
```

- [ ] **Step 2: Write header helper tests**

Create `test/utils/response-headers.spec.ts`:

```ts
import {
  captureReplayHeaders,
  replayStoredHeaders,
} from '../../src/utils/response-headers';

describe('response header replay helpers', () => {
  it('captures the default allowlist and x- headers', () => {
    const res = {
      getHeaders: () => ({
        'content-type': 'application/json',
        location: '/payments/pay_1',
        etag: '"abc"',
        'cache-control': 'private',
        'x-request-id': 'req_1',
        authorization: 'secret',
      }),
    };

    expect(captureReplayHeaders(res, true)).toEqual({
      'content-type': 'application/json',
      location: '/payments/pay_1',
      etag: '"abc"',
      'cache-control': 'private',
      'x-request-id': 'req_1',
    });
  });

  it('never captures denied headers even when explicitly allowed', () => {
    const res = {
      getHeaders: () => ({
        'set-cookie': 'sid=1',
        connection: 'keep-alive',
        location: '/ok',
      }),
    };

    expect(
      captureReplayHeaders(res, ['set-cookie', 'connection', 'location']),
    ).toEqual({ location: '/ok' });
  });

  it('returns undefined when disabled or no headers match', () => {
    expect(captureReplayHeaders({ getHeaders: () => ({ location: '/x' }) }, false))
      .toBeUndefined();
    expect(captureReplayHeaders({ getHeaders: () => ({ authorization: 'x' }) }, true))
      .toBeUndefined();
  });

  it('replays through setHeader when available', () => {
    const setHeader = jest.fn();
    replayStoredHeaders({ setHeader }, { location: '/payments/pay_1' });

    expect(setHeader).toHaveBeenCalledWith('location', '/payments/pay_1');
  });

  it('replays through Fastify header() when setHeader is absent', () => {
    const header = jest.fn();
    replayStoredHeaders({ header }, { location: '/payments/pay_1' });

    expect(header).toHaveBeenCalledWith('location', '/payments/pay_1');
  });
});
```

- [ ] **Step 3: Run header helper tests and confirm failure**

Run:

```powershell
npm test -- test/utils/response-headers.spec.ts --runInBand
```

Expected: FAIL because `src/utils/response-headers.ts` does not exist.

- [ ] **Step 4: Implement header helpers**

Create `src/utils/response-headers.ts`:

```ts
import type { ReplayHeadersOption } from '../interfaces/idempotency-options.interface';

type HeaderValue = string | number | readonly string[] | undefined;

export interface HeaderCaptureResponse {
  getHeaders?: () => Record<string, HeaderValue>;
}

export interface HeaderReplayResponse {
  setHeader?: (name: string, value: string) => unknown;
  header?: (name: string, value: string) => unknown;
}

const DEFAULT_ALLOWED = new Set([
  'content-type',
  'location',
  'etag',
  'cache-control',
]);

const DENIED = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

export function captureReplayHeaders(
  res: HeaderCaptureResponse,
  option: ReplayHeadersOption | undefined,
): Record<string, string> | undefined {
  if (option === false || typeof res.getHeaders !== 'function') {
    return undefined;
  }

  const explicit = Array.isArray(option)
    ? new Set(option.map((name) => name.toLowerCase()))
    : undefined;
  const captured: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(res.getHeaders())) {
    const name = rawName.toLowerCase();
    if (DENIED.has(name)) continue;
    if (!isAllowed(name, explicit)) continue;

    const value = stringifyHeaderValue(rawValue);
    if (value !== undefined) {
      captured[name] = value;
    }
  }

  return Object.keys(captured).length > 0 ? captured : undefined;
}

export function replayStoredHeaders(
  res: HeaderReplayResponse,
  headers: Record<string, string> | undefined,
): void {
  if (!headers) return;

  for (const [name, value] of Object.entries(headers)) {
    if (DENIED.has(name)) continue;
    if (typeof res.setHeader === 'function') {
      res.setHeader(name, value);
      continue;
    }
    if (typeof res.header === 'function') {
      res.header(name, value);
    }
  }
}

function isAllowed(name: string, explicit: Set<string> | undefined): boolean {
  if (explicit) return explicit.has(name);
  return DEFAULT_ALLOWED.has(name) || name.startsWith('x-');
}

function stringifyHeaderValue(value: HeaderValue): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
```

- [ ] **Step 5: Run header helper tests and confirm pass**

Run:

```powershell
npm test -- test/utils/response-headers.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit header helper foundation**

```bash
git add src/utils/response-headers.ts test/utils/response-headers.spec.ts src/interfaces/idempotency-options.interface.ts src/index.ts
git commit -m "feat: add response header replay policy"
```

---

### Task 7: Capture and Replay Response Headers in the Interceptor

**Files:**
- Modify: `test/support/execution-context.factory.ts`
- Modify: `src/idempotency.interceptor.ts`
- Modify: `test/idempotency.interceptor.spec.ts`
- Modify: `test/e2e/idempotency.e2e-spec.ts`

- [ ] **Step 1: Extend fake response helper**

In `test/support/execution-context.factory.ts`, update `FakeResponse`:

```ts
export interface FakeResponse {
  statusCode: number;
  status: jest.Mock<FakeResponse, [number]>;
  getHeaders: jest.Mock<Record<string, string>>;
  setHeader: jest.Mock<FakeResponse, [string, string]>;
}
```

Replace `buildResponse` with:

```ts
export const buildResponse = (
  initialStatus = 200,
  initialHeaders: Record<string, string> = {},
): FakeResponse => {
  const headers: Record<string, string> = { ...initialHeaders };
  const res: Partial<FakeResponse> = { statusCode: initialStatus };
  res.status = jest.fn((code: number): FakeResponse => {
    (res as FakeResponse).statusCode = code;
    return res as FakeResponse;
  });
  res.getHeaders = jest.fn(() => ({ ...headers }));
  res.setHeader = jest.fn((name: string, value: string): FakeResponse => {
    headers[name.toLowerCase()] = value;
    return res as FakeResponse;
  });
  return res as FakeResponse;
};
```

- [ ] **Step 2: Add interceptor header capture/replay tests**

In `test/idempotency.interceptor.spec.ts`, add this block before binary response tests:

```ts
  describe('K. response header replay', () => {
    it('captures allowed response headers before emitting the original response', async () => {
      const { interceptor, storage } = buildInterceptor();
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(201, {
        location: '/payments/pay_1',
        'x-request-id': 'req_1',
        'set-cookie': 'sid=secret',
      });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-headers' },
          body: { amount: 100 },
        },
        res,
        handler,
      });
      const next = buildCallHandler(of({ id: 'pay_1' }));

      await firstValueFrom(interceptor.intercept(context, next));

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
    });

    it('replays stored headers and status for completed records', async () => {
      const { interceptor, storage } = buildInterceptor();
      storage.seed({
        key: 'K-replay-headers',
        fingerprint: sha256({ amount: 100 }),
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

      const result = await firstValueFrom(
        interceptor.intercept(context, buildCallHandler()),
      );

      expect(result).toEqual({ id: 'pay_1' });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.setHeader).toHaveBeenCalledWith('location', '/payments/pay_1');
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req_1');
    });

    it('does not capture headers when replayHeaders=false', async () => {
      const { interceptor, storage } = buildInterceptor({ replayHeaders: false });
      const handler = decoratedHandler({ enabled: true });
      const res = buildResponse(201, { location: '/payments/pay_1' });
      const { context } = buildExecutionContext({
        req: {
          method: 'POST',
          headers: { 'idempotency-key': 'K-no-headers' },
          body: {},
        },
        res,
        handler,
      });

      await firstValueFrom(
        interceptor.intercept(context, buildCallHandler(of({ ok: true }))),
      );

      expect(storage.complete).toHaveBeenCalledWith(
        'K-no-headers',
        expect.any(String),
        { statusCode: 201, body: '{"ok":true}', headers: undefined },
        86_400,
      );
    });
  });
```

If the existing binary response block is named `K`, rename it to `L. binary response detection (P2 regression)`.

- [ ] **Step 3: Run interceptor tests and confirm failure**

Run:

```powershell
npm test -- test/idempotency.interceptor.spec.ts --runInBand
```

Expected: FAIL on header capture/replay tests.

- [ ] **Step 4: Wire header helpers into interceptor**

In `src/idempotency.interceptor.ts`, import:

```ts
import {
  captureReplayHeaders,
  replayStoredHeaders,
  type HeaderCaptureResponse,
  type HeaderReplayResponse,
} from './utils/response-headers';
```

Extend `ResolvedOptions`:

```ts
  replayHeaders: boolean | string[] | undefined;
```

Extend `ResponseShape`:

```ts
interface ResponseShape extends HeaderCaptureResponse, HeaderReplayResponse {
  statusCode?: number;
  status: (code: number) => unknown;
}
```

In `resolveOptions()`, include:

```ts
      replayHeaders: this.moduleOptions.replayHeaders ?? true,
```

In `handleExistingRecord()`, after setting status and before parsing body:

```ts
    replayStoredHeaders(res, existing.responseHeaders);
```

Change the `captureResponse()` call in `acquireAndRun()`:

```ts
            this.captureResponse(scopedKey, token, value, res, opts),
```

Change the `captureResponse()` signature:

```ts
    opts: ResolvedOptions,
```

Inside `captureResponse()`, replace `ttl` references with `opts.ttl`.

Before `storage.complete()`, capture headers:

```ts
    const headers = captureReplayHeaders(res, opts.replayHeaders);
```

Pass headers to storage:

```ts
        { statusCode, body: serialized, headers },
        opts.ttl,
```

- [ ] **Step 5: Run targeted tests**

Run:

```powershell
npm test -- test/utils/response-headers.spec.ts test/idempotency.interceptor.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Add Express e2e header replay case**

In `test/e2e/idempotency.e2e-spec.ts`, import `Header`:

```ts
  Header,
```

Add a route to `PaymentsController`:

```ts
  @Post('with-headers')
  @HttpCode(201)
  @Header('Location', '/payments/pay_header')
  @Header('X-Request-Id', 'req_header')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  withHeaders(@Body() dto: { amount: number }) {
    callCounter.create += 1;
    return { id: `pay_header_${callCounter.create}`, amount: dto.amount };
  }
```

Add this test:

```ts
  it('replays allowed response headers', async () => {
    const first = await request(app.getHttpServer())
      .post('/payments/with-headers')
      .set('Idempotency-Key', 'header-key')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.headers.location).toBe('/payments/pay_header');
    expect(first.headers['x-request-id']).toBe('req_header');

    const second = await request(app.getHttpServer())
      .post('/payments/with-headers')
      .set('Idempotency-Key', 'header-key')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe('/payments/pay_header');
    expect(second.headers['x-request-id']).toBe('req_header');
  });
```

- [ ] **Step 7: Run Express e2e**

Run:

```powershell
npm run test:e2e -- test/e2e/idempotency.e2e-spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit interceptor header replay**

```bash
git add test/support/execution-context.factory.ts src/idempotency.interceptor.ts test/idempotency.interceptor.spec.ts test/e2e/idempotency.e2e-spec.ts
git commit -m "feat: replay safe response headers"
```

---

### Task 8: Add Fastify E2E Verification

**Files:**
- Create: `test/e2e/fastify.e2e-spec.ts`

- [ ] **Step 1: Create Fastify e2e suite**

Create `test/e2e/fastify.e2e-spec.ts`:

```ts
import 'reflect-metadata';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  Module,
  Post,
  UseInterceptors,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';

import { IdempotencyModule } from '../../src/idempotency.module';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { Idempotent } from '../../src/idempotency.decorator';
import { MemoryStorage } from '../../src/storage/memory.storage';

const calls = { create: 0, capture: 0, headers: 0 };

@Controller('fastify-payments')
class FastifyPaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: { amount: number }) {
    calls.create += 1;
    return { id: `fp_${calls.create}`, amount: dto.amount };
  }

  @Post(':id/capture')
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  capture(@Body() dto: { amount: number }) {
    calls.capture += 1;
    return { id: `fc_${calls.capture}`, amount: dto.amount };
  }

  @Post('headers')
  @HttpCode(201)
  @Header('Location', '/fastify-payments/fp_header')
  @Header('X-Request-Id', 'fastify_req')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  headers(@Body() dto: { amount: number }) {
    calls.headers += 1;
    return { id: `fh_${calls.headers}`, amount: dto.amount };
  }
}

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage: new MemoryStorage(),
      scope: 'endpoint',
    }),
  ],
  controllers: [FastifyPaymentsController],
})
class FastifyTestModule {}

describe('Idempotency Fastify adapter (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FastifyTestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    calls.create = 0;
    calls.capture = 0;
    calls.headers = 0;
  });

  it('replays a duplicate response without re-running the handler', async () => {
    const first = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-replay')
      .send({ amount: 100 });

    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-replay')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(calls.create).toBe(1);
  });

  it('returns 400 when the required key is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/fastify-payments')
      .send({ amount: 100 });

    expect(res.status).toBe(400);
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 100 });

    const res = await request(app.getHttpServer())
      .post('/fastify-payments')
      .set('Idempotency-Key', 'fastify-mismatch')
      .send({ amount: 200 });

    expect(res.status).toBe(422);
  });

  it('does not conflate parameterized route targets', async () => {
    const first = await request(app.getHttpServer())
      .post('/fastify-payments/pay_1/capture')
      .set('Idempotency-Key', 'fastify-capture')
      .send({ amount: 100 });

    const second = await request(app.getHttpServer())
      .post('/fastify-payments/pay_2/capture')
      .set('Idempotency-Key', 'fastify-capture')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe('fc_1');
    expect(second.body.id).toBe('fc_2');
    expect(calls.capture).toBe(2);
  });

  it('replays allowed headers under Fastify', async () => {
    const first = await request(app.getHttpServer())
      .post('/fastify-payments/headers')
      .set('Idempotency-Key', 'fastify-headers')
      .send({ amount: 100 });

    const second = await request(app.getHttpServer())
      .post('/fastify-payments/headers')
      .set('Idempotency-Key', 'fastify-headers')
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe('/fastify-payments/fp_header');
    expect(second.headers['x-request-id']).toBe('fastify_req');
    expect(calls.headers).toBe(1);
  });
});
```

- [ ] **Step 2: Run Fastify e2e**

Run:

```powershell
npm run test:e2e -- test/e2e/fastify.e2e-spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit Fastify verification**

```bash
git add test/e2e/fastify.e2e-spec.ts
git commit -m "test: verify fastify adapter behavior"
```

---

### Task 9: Add Real Redis Smoke Coverage

**Files:**
- Create: `test/storage/redis.storage.real.spec.ts`

- [ ] **Step 1: Create real Redis gated spec**

Create `test/storage/redis.storage.real.spec.ts`:

```ts
import { Redis } from 'ioredis';

import { RedisStorage } from '../../src/storage/redis.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const REDIS_URL = process.env.TEST_REDIS_URL;
const describeOrSkip = REDIS_URL ? describe : describe.skip;

if (!REDIS_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[redis.storage.real.spec] TEST_REDIS_URL not set - real Redis tests skipped.',
  );
}

describeOrSkip('RedisStorage real Redis', () => {
  const prefix = `idempotency:test:${Date.now()}:`;

  describeStorageContract('RedisStorage real Redis', async () => {
    const client = new Redis(REDIS_URL!);
    const storage = new RedisStorage({ client, keyPrefix: prefix });
    return {
      storage,
      cleanup: async () => {
        const keys = await client.keys(`${prefix}*`);
        if (keys.length > 0) {
          await client.del(...keys);
        }
        await client.quit();
      },
    };
  });
});
```

- [ ] **Step 2: Run without Redis URL and confirm skip**

Run:

```powershell
Remove-Item Env:TEST_REDIS_URL -ErrorAction SilentlyContinue
npm run test:redis
```

Expected: PASS with skip warning.

- [ ] **Step 3: Run with Redis when available**

Run:

```powershell
$env:TEST_REDIS_URL='redis://localhost:6379'
npm run test:redis
```

Expected with local Redis running: PASS.

- [ ] **Step 4: Commit real Redis smoke spec**

```bash
git add test/storage/redis.storage.real.spec.ts
git commit -m "test: add real redis storage smoke coverage"
```

---

### Task 10: Harden CI and Release Workflows

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Update NestJS v10 override in CI**

In `.github/workflows/ci.yml`, update the `Install NestJS v10 (matrix override)` command to include Fastify:

```yaml
          npm install --no-save \
            @nestjs/common@^10 \
            @nestjs/core@^10 \
            @nestjs/platform-express@^10 \
            @nestjs/platform-fastify@^10 \
            @nestjs/testing@^10
```

- [ ] **Step 2: Add Redis smoke job to CI**

Add this job after `test` and before `pack`:

```yaml
  redis-smoke:
    name: Redis smoke
    needs: lint
    runs-on: ubuntu-latest

    services:
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Real Redis smoke tests
        env:
          TEST_REDIS_URL: redis://localhost:6379
        run: npm run test:redis
```

Update `pack` dependencies:

```yaml
    needs: [test, redis-smoke]
```

- [ ] **Step 3: Add Postgres service to release build-and-test**

In `.github/workflows/release.yml`, add this service under `build-and-test`:

```yaml
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: idempotency_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U test -d idempotency_test"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
```

Add env to the `Clean + lint + test + build` step:

```yaml
        env:
          TEST_DATABASE_URL: postgresql://test:test@localhost:5432/idempotency_test
```

- [ ] **Step 4: Validate workflow syntax through local lint-level parsing**

Run:

```powershell
npx prettier --check ".github/workflows/*.yml"
```

Expected: PASS.

- [ ] **Step 5: Commit workflow hardening**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: harden release and redis validation"
```

---

### Task 11: Update Documentation and Changelog

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add README endpoint scoping text**

In README Scope section, replace the `'endpoint'` behavior sentence with:

```md
`'endpoint'` | **Default.** Prepends `HTTP_METHOD /actual/path::` to the key, using the request path without the query string (e.g. `POST /payments/pay_1/capture::my-key`). This isolates parameterized resources such as `/orders/1` and `/orders/2`. Query strings are intentionally excluded to avoid accidental key drift from query ordering; use a custom `scope` function if query values must participate in idempotency.
```

- [ ] **Step 2: Add README stable fingerprint text**

Replace the caveat about insertion-order `JSON.stringify` with:

```md
- **Body fingerprint uses stable JSON serialization.** Object keys are sorted recursively before hashing, so semantically equivalent JSON objects with different key order produce the same fingerprint. Array order remains significant.
```

- [ ] **Step 3: Add README response header replay section**

Add under "How it works" or "Configuration reference":

````md
### Response header replay

v0.3 caches and replays a conservative set of response headers by default:
`Content-Type`, `Location`, `ETag`, `Cache-Control`, and custom `X-*` headers.
Unsafe or hop-by-hop headers such as `Set-Cookie`, `Connection`, and
`Transfer-Encoding` are never cached.

Configure header replay at module level:

```ts
IdempotencyModule.forRoot({
  storage: new MemoryStorage(),
  replayHeaders: true, // default allowlist
});

IdempotencyModule.forRoot({
  storage: new MemoryStorage(),
  replayHeaders: ['location', 'x-request-id'], // explicit allowlist
});

IdempotencyModule.forRoot({
  storage: new MemoryStorage(),
  replayHeaders: false, // status/body only
});
```
````

- [ ] **Step 4: Add README Postgres migration note**

In PostgreSQL storage schema migration section, add:

````md
For existing v0.2.x Postgres installations upgrading to v0.3.0, add the
response header column once:

```sql
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS response_headers JSONB;
```
````

- [ ] **Step 5: Update deferred/future lists**

Remove stable JSON stringify, response header replay, and Fastify verification
from deferred v0.3 items. Keep future work that remains outside v0.3.0, such as
transactional integration and metrics.

- [ ] **Step 6: Add CHANGELOG entry**

At the top of `CHANGELOG.md`, add:

```md
## [0.3.0] - 2026-05-10

### Added

- Added stable JSON request fingerprinting so object key order does not cause false 422 responses.
- Added safe response header capture and replay for `Content-Type`, `Location`, `ETag`, `Cache-Control`, and `X-*` headers.
- Added Fastify adapter e2e verification.
- Added real Redis smoke coverage in CI.

### Changed

- Changed default endpoint scoping to use the actual request path without query string, fixing collisions for parameterized routes.
- Hardened release validation so Postgres-backed tests run before npm publish.

### Migration

- Existing Postgres users should add `response_headers JSONB`:
  `ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS response_headers JSONB;`
```

- [ ] **Step 7: Run docs formatting check**

Run:

```powershell
npx prettier --check README.md CHANGELOG.md docs/superpowers/specs/2026-05-10-v0-3-0-reliability-design.md
```

Expected: PASS.

- [ ] **Step 8: Commit docs**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document v0.3.0 reliability changes"
```

---

### Task 12: Final Verification

**Files:**
- No code changes.

- [ ] **Step 1: Run lint**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 2: Run unit tests**

Run:

```powershell
npm run test
```

Expected: exit code 0.

- [ ] **Step 3: Run e2e tests**

Run:

```powershell
npm run test:e2e
```

Expected: exit code 0.

- [ ] **Step 4: Run build**

Run:

```powershell
npm run build
```

Expected: exit code 0 and `dist/` emitted.

- [ ] **Step 5: Run Postgres-backed suite when local Postgres is available**

Run:

```powershell
docker compose up -d postgres
$env:TEST_DATABASE_URL='postgresql://test:test@localhost:5432/idempotency_test'
npm run test:all
```

Expected: exit code 0 with Postgres tests executed rather than skipped.

- [ ] **Step 6: Run real Redis smoke when local Redis is available**

Run:

```powershell
$env:TEST_REDIS_URL='redis://localhost:6379'
npm run test:redis
```

Expected: exit code 0 with `RedisStorage real Redis` tests executed.

- [ ] **Step 7: Run publish dry run**

Run:

```powershell
npm pack --dry-run
```

Expected: tarball includes `dist`, `sql`, `README.md`, and `LICENSE`.

- [ ] **Step 8: Commit any final fixes**

If verification produced code or docs fixes, commit them:

```bash
git add .
git commit -m "chore: prepare v0.3.0 reliability release"
```

If there were no final fixes, leave the prior task commits as the complete history.

---

## Spec Coverage Review

- Actual request target based endpoint scoping is covered by Tasks 3 and 8.
- Stable JSON fingerprinting is covered by Task 2.
- Response header capture and replay is covered by Tasks 4, 5, 6, 7, and 8.
- Fastify adapter verification is covered by Task 8 and Task 10's dependency matrix update.
- CI and release hardening is covered by Tasks 9 and 10.
- Documentation and migration notes are covered by Task 11.
- Final verification is covered by Task 12.
