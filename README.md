# @nestarc/idempotency

> IETF draft-07-compatible idempotency module for NestJS — decorator-based, pluggable storage (memory/Redis/Postgres), response replay, fingerprint validation, processing leases, and observability hooks.

[![CI](https://github.com/nestarc/idempotency/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nestarc/idempotency/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@nestarc/idempotency.svg)](https://www.npmjs.com/package/@nestarc/idempotency)
[![license](https://img.shields.io/npm/l/@nestarc/idempotency.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.x%20%7C%2011.x-ea2845.svg)](https://nestjs.com/)
[![provenance](https://img.shields.io/badge/npm-provenance-blue.svg)](https://docs.npmjs.com/generating-provenance-statements)

## Why

Non-idempotent HTTP methods (`POST`, `PATCH`, `DELETE`) can be processed multiple times when:

- A client times out and the user retries the request
- An API gateway or load balancer auto-retries
- A flaky mobile network resends a request without realizing the first attempt succeeded
- Microservices duplicate messages between hops

The result is double charges, duplicate orders, and corrupt state. The IETF draft [`httpapi-idempotency-key-header-07`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) describes a solution: clients send an `Idempotency-Key` header with a unique value, and the server makes retries safe by replaying the original response when the original request completed.

`@nestarc/idempotency` is a clean-room NestJS implementation of that draft-compatible behavior, with a one-line decorator API and pluggable storage. It does not claim full exactly-once execution across your business database transaction; it protects the HTTP mutation boundary and uses token-CAS storage records to prevent stale writers from clobbering newer records.

## Install

```bash
npm install @nestarc/idempotency
```

If you plan to use the Redis storage adapter, also install `ioredis`:

```bash
npm install ioredis
```

If you plan to use the PostgreSQL storage adapter, also install `pg`:

```bash
npm install pg
```

## Quick start

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { IdempotencyModule, MemoryStorage } from '@nestarc/idempotency';

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage: new MemoryStorage(),
      ttl: 86400, // 24 hours
    }),
  ],
})
export class AppModule {}
```

```ts
// payments.controller.ts
import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import { Idempotent, IdempotencyInterceptor } from '@nestarc/idempotency';

@Controller('payments')
@UseInterceptors(IdempotencyInterceptor)
export class PaymentsController {
  @Post()
  @Idempotent()
  createPayment(@Body() dto: CreatePaymentDto) {
    // Your business logic. Runs at most once per Idempotency-Key.
    return this.paymentService.process(dto);
  }
}
```

That's it. A duplicate `POST /payments` with the same `Idempotency-Key` header will replay the cached response without re-running your handler.

### Three ways to wire the interceptor

The module deliberately does **not** auto-register the interceptor — you opt in with one of these patterns:

```ts
// 1. App-global — applies to every controller
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from '@nestarc/idempotency';

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
})
export class AppModule {}
```

```ts
// 2. Controller-scoped
@Controller('payments')
@UseInterceptors(IdempotencyInterceptor)
export class PaymentsController { ... }
```

```ts
// 3. Method-scoped
@Post()
@UseInterceptors(IdempotencyInterceptor)
@Idempotent()
createPayment() { ... }
```

In all three cases, only handlers decorated with `@Idempotent()` are processed. Routes without the decorator pass through untouched.

## Redis storage

```ts
import { IdempotencyModule, RedisStorage } from '@nestarc/idempotency';
import { Redis } from 'ioredis';

const client = new Redis({ host: 'localhost', port: 6379 });

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage: new RedisStorage({ client }),
      ttl: 86400,
    }),
  ],
})
export class AppModule {}
```

Or async via `ConfigService`:

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IdempotencyModule, RedisStorage } from '@nestarc/idempotency';
import { Redis } from 'ioredis';

@Module({
  imports: [
    IdempotencyModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: new RedisStorage({
          client: new Redis({
            host: config.get('REDIS_HOST'),
            port: config.get('REDIS_PORT'),
          }),
        }),
        ttl: config.get('IDEMPOTENCY_TTL', 86400),
      }),
    }),
  ],
})
export class AppModule {}
```

## PostgreSQL storage

If your stack already runs Postgres, you can avoid adding Redis just for
idempotency. The Postgres adapter ships with the same atomic-NX +
token-CAS guarantees as Redis, with lazy expiration on `get()` and an
optional sweep service for active cleanup.

```ts
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { IdempotencyModule, PostgresStorage } from '@nestarc/idempotency';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage: new PostgresStorage({ pool }),
    }),
  ],
})
export class AppModule {}
```

### Schema migration

Three options, pick whichever fits your tooling:

1. **SQL file (recommended for production):**
   ```bash
   psql "$DATABASE_URL" -f node_modules/@nestarc/idempotency/sql/init.sql
   ```
2. **Code helper (good for tests / scripts):**
   ```ts
   import { PostgresStorage } from '@nestarc/idempotency';
   await PostgresStorage.createSchema(pool);
   ```
3. **Auto on module init (development only):**
   ```ts
   new PostgresStorage({ pool, autoCreateSchema: true });
   ```

For existing v0.2.x Postgres installations upgrading to v0.3.0, add the
response header column once:

```sql
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS response_headers JSONB;
```

### Optional sweep service

Lazy expiration on `get()` already guarantees correctness. The sweep
service exists only to bound disk usage in long-running deployments:

```ts
import {
  IdempotencyModule,
  PostgresStorage,
  PostgresSweepService,
  IDEMPOTENCY_SWEEP_OPTIONS,
} from '@nestarc/idempotency';

@Module({
  imports: [IdempotencyModule.forRoot({ storage: new PostgresStorage({ pool }) })],
  providers: [
    PostgresSweepService,
    {
      provide: IDEMPOTENCY_SWEEP_OPTIONS,
      useValue: { enabled: true, intervalMs: 60_000 },
    },
  ],
})
export class AppModule {}
```

Or schedule it externally with `pg_cron`:

```sql
SELECT cron.schedule('idempotency-sweep', '* * * * *',
  $$DELETE FROM idempotency_records WHERE expires_at < now()$$);
```

> Multi-replica safe: each sweep wraps the DELETE in
> `pg_try_advisory_lock` so only one replica per cycle does the work.

## Configuration reference

### Module options (`IdempotencyModule.forRoot(...)`)

| Option          | Type                                           | Default             | Description                                                                         |
| --------------- | ---------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `storage`       | `IdempotencyStorage`                           | (required)          | A storage adapter instance (e.g. `new MemoryStorage()`).                            |
| `ttl`           | `number` (seconds)                             | `86400`             | Completed replay record TTL. Per-handler can override.                              |
| `processingTtl` | `number` (seconds)                             | same as `ttl`       | Optional in-flight PROCESSING record TTL.                                           |
| `headerName`    | `string`                                       | `'Idempotency-Key'` | HTTP header carrying the key. Defaults to the IETF draft header name.               |
| `keyResolver`   | `(ctx) => string \| undefined \| Promise<...>` | header lookup       | Resolve keys from webhook event ids, command ids, or other application values.      |
| `maxKeyLength`  | `number`                                       | `255`               | Maximum accepted key length.                                                        |
| `fingerprint`   | `boolean \| resolver`                          | `true`              | Compute a SHA-256 body fingerprint or provide a semantic custom fingerprint.         |
| `scope`         | `IdempotencyScope`                             | `'endpoint'`        | How storage keys are namespaced. See [Scope](#scope) below.                         |
| `replayHeaders` | `boolean \| string[]`                          | `true`              | Replay the default safe allowlist, an explicit allowlist, or disable header replay. |
| `observability` | `{ onEvent?, exposeStatusHeaders? }`           | status headers on   | Emit outcome events and expose `Idempotency-Status` headers.                        |
| `isGlobal`      | `boolean`                                      | `true`              | Register as a NestJS global module.                                                 |

#### Scope

The `scope` option controls how the storage key is derived from the raw header value. It matters when two different endpoints might receive the same `Idempotency-Key` value from a client.

| Value        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'endpoint'` | **Default.** Prepends `HTTP_METHOD /actual/path::` to the key, using the request path without the query string (e.g. `POST /payments/pay_1/capture::my-key`). This isolates parameterized resources such as `/orders/1` and `/orders/2`. Query strings are intentionally excluded to avoid accidental key drift from query ordering; use a custom `scope` function if query values must participate in idempotency. |
| `'global'`   | Use the raw header value as-is. Safe only if clients guarantee globally-unique keys across all endpoints (Stripe-style).                                                                                                                                                                                                                                                                                            |
| function     | `(ctx: ExecutionContext) => string`. Fully custom scoping — useful in multi-tenant systems where the scope should include the tenant id. The returned string is joined to the raw key with `::`.                                                                                                                                                                                                                    |

```ts
// Multi-tenant example: include the tenant ID in the scope.
IdempotencyModule.forRoot({
  storage: new MemoryStorage(),
  scope: (ctx) => {
    const req = ctx.switchToHttp().getRequest();
    return `${req.user.tenantId}`;
  },
});
```

### Decorator options (`@Idempotent(options?)`)

| Option          | Type                  | Default | Description                                                                             |
| --------------- | --------------------- | ------- | --------------------------------------------------------------------------------------- |
| `required`      | `boolean`             | `true`  | If true and no key is resolved, the interceptor returns 400. If false, pass-through.    |
| `ttl`           | `number`              | inherit | Override the module-level completed replay TTL for this handler.                        |
| `processingTtl` | `number`              | inherit | Override the module-level in-flight processing TTL for this handler.                    |
| `keyResolver`   | key resolver function | inherit | Override module-level key resolution for this handler.                                  |
| `maxKeyLength`  | `number`              | inherit | Override module-level key length validation for this handler.                           |
| `fingerprint`   | `boolean \| resolver` | inherit | Override the module-level fingerprint setting or resolver.                              |

### Processing leases

By default, `PROCESSING` records and completed replay records use the same
`ttl`. For long replay windows, you can use a shorter `processingTtl` so stuck
in-flight records expire sooner after a crash:

```ts
IdempotencyModule.forRoot({
  storage: new RedisStorage(redis),
  ttl: 86400,        // replay completed responses for 24 hours
  processingTtl: 60, // release stuck in-flight records after 60 seconds
});
```

Choose `processingTtl` above the endpoint's real p99 processing time. Too-short
processing leases can allow a retry to acquire the key while the original
request is still running.

### Custom key and fingerprint resolvers

Use `keyResolver` when the stable key comes from a webhook event id or command
id instead of the `Idempotency-Key` header:

```ts
@Post('webhooks/stripe')
@Idempotent({
  keyResolver: (ctx) => {
    const req = ctx.switchToHttp().getRequest<{ body: { id: string } }>();
    return req.body.id;
  },
  fingerprint: ({ body }) => {
    const event = body as { type: string; data: { object: { id: string } } };
    return `${event.type}:${event.data.object.id}`;
  },
})
handleStripeWebhook(@Body() event: StripeEvent) {
  return this.webhookService.process(event);
}
```

The boolean `fingerprint` behavior remains unchanged. A custom resolver replaces
the default body hash and should return a deterministic semantic fingerprint.

### Observability

v0.4 emits optional outcome events and status headers:

```ts
IdempotencyModule.forRoot({
  storage: new PostgresStorage(pool),
  observability: {
    onEvent: (event) => {
      metrics.increment(`idempotency.${event.outcome}`);
    },
  },
});
```

Status headers are enabled by default:

- `Idempotency-Status: created`
- `Idempotency-Status: replayed` plus `Idempotency-Replayed: true`
- `Idempotency-Status: conflict`
- `Idempotency-Status: mismatch`

Set `observability: { exposeStatusHeaders: false }` to disable these headers.

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

## How it works

```
Client Request (with Idempotency-Key header)
    │
    ▼
[IdempotencyInterceptor]
    │
    ├─ 1. Read metadata + Idempotency-Key header
    │     ├─ no @Idempotent → pass through
    │     ├─ missing header + required=true → 400 Bad Request
    │     └─ resolve TTL (reject 0/negative/fractional/NaN/Infinity)
    │
    ├─ 2. Apply scope to the key
    │     (default: `HTTP_METHOD /actual/path::`, without query string)
    │
    ├─ 3. Look up the scoped key in storage
    │     ├─ COMPLETED + fingerprint match       → replay cached response
    │     ├─ fingerprint mismatch (any status)   → 422 Unprocessable Entity
    │     ├─ PROCESSING                           → 409 Conflict
    │     └─ not found                            → step 4
    │
    ├─ 4. Atomically create a PROCESSING record (token-based NX)
    │     ├─ acquired=true  → step 5 with the returned token
    │     └─ acquired=false → re-read the record and loop back to step 3
    │                         (the winner may be COMPLETED → replay,
    │                          COMPLETED+mismatch → 422, or PROCESSING → 409)
    │
    ├─ 5. Run the controller handler
    │
    └─ 6. Capture the response
          ├─ plain JSON             → storage.complete(token, statusCode, body, safe headers)
          │   ├─ 'ok'               → emit handler value
          │   ├─ 'stale' (TTL race) → warn + emit (don't clobber newer record)
          │   └─ throws (transient) → ERROR log + emit (don't delete — retries
          │                            hit 409 until TTL reclaims the record,
          │                            never duplicate execution)
          ├─ Buffer / stream / etc. → bypass cache + warn + emit + delete
          └─ handler threw          → delete record (best-effort) + rethrow
```

The interceptor uses RxJS `concatMap` to ensure the storage write completes **before** the response is emitted to the client — preventing a race window where a duplicate request arriving microseconds later could observe the wrong state.

Storage adapters implement **token-based compare-and-set**: each `create()` returns an opaque token that the interceptor passes back to `complete()` / `delete()`. A slow caller whose PROCESSING record was evicted by TTL and replaced by a newer request cannot clobber the newer record — the storage returns `'stale'` and the interceptor logs a warning while still emitting the handler's value to the original caller.

## Error reference

| Status | When                                                                                                                                                                   | IETF rationale                    |
| -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
|    400 | `Idempotency-Key` header is missing and `required: true` (the default), or a configured `ttl` is not a positive integer                                                | client contract / developer error |
|    409 | The record under this scoped key is currently `PROCESSING` — either observed on the initial read or after losing an atomic `create()` race to a winner still in flight | concurrent duplicate              |
|    422 | A record exists under this scoped key with a different request-body fingerprint (reused key with new payload)                                                          | key reused with new payload       |

Note that v0.1.3+ returns a **replay** (not a 409) when the race winner has already finished — the interceptor re-reads the record on a lost `create()` race and dispatches through the same state machine as the initial-read branch.

## Storage adapters

| Feature          | `MemoryStorage`        | `RedisStorage`         | `PostgresStorage`                        |
| ---------------- | ---------------------- | ---------------------- | ---------------------------------------- |
| Scope            | single process         | shared across replicas | shared across replicas                   |
| Persistence      | none (lost on restart) | full Redis durability  | full Postgres durability                 |
| TTL mechanism    | `setTimeout`           | Redis `EXPIRE`         | lazy on `get()` + optional sweep service |
| Cluster-safe     | ❌                     | ✅                     | ✅                                       |
| Production-ready | ❌ (dev/test only)     | ✅                     | ✅                                       |
| Required peer    | none                   | `ioredis ^5`           | `pg ^8.11`                               |

### Custom storage adapters

Implement the `IdempotencyStorage` interface. The contract is **token-based compare-and-set**: `create()` returns an opaque token, and `complete()` / `delete()` require the caller to pass the matching token back. This prevents a slow caller whose record was evicted by TTL from clobbering a newer caller's record.

```ts
import type {
  IdempotencyStorage,
  IdempotencyRecord,
  CreateResult,
  CompleteResponse,
  MutateResult,
} from '@nestarc/idempotency';
import type { OnModuleDestroy } from '@nestjs/common';

class MyStorage implements IdempotencyStorage, OnModuleDestroy {
  async get(key: string): Promise<IdempotencyRecord | null> {
    // Return the record, or null if it doesn't exist / has expired.
  }

  async create(
    key: string,
    fingerprint: string | undefined,
    ttlSeconds: number,
  ): Promise<CreateResult> {
    // NX semantics: if the key already exists, return { acquired: false }.
    // Otherwise, generate an opaque token (e.g. randomUUID()), persist it
    // alongside the PROCESSING record, and return { acquired: true, token }.
    // `createdAt` must equal the moment of creation and be preserved
    // verbatim across subsequent complete() calls.
  }

  async complete(
    key: string,
    token: string,
    response: CompleteResponse,
    ttlSeconds: number,
  ): Promise<MutateResult> {
    // Compare-and-set: only mutate the record if its stored token matches
    // the caller's. Return 'ok' on success; return 'stale' if the token
    // does NOT match (the original record was evicted and replaced) or if
    // the record is missing. Refresh `expiresAt` to now + ttlSeconds, but
    // preserve the original `createdAt`.
  }

  async delete(key: string, token: string): Promise<MutateResult> {
    // Idempotent cleanup: return 'ok' if the record matched-and-was-removed
    // OR was already absent. Return 'stale' only if a DIFFERENT record
    // (with a different token) exists under this key — in that case, do
    // NOT remove it.
  }

  // Optional but recommended: Nest will call this during app.close().
  async onModuleDestroy(): Promise<void> {
    // Release any external resources (DB connections, timers, ...).
  }
}
```

Then pass an instance to `IdempotencyModule.forRoot({ storage: new MyStorage() })`.

The package ships a **shared contract test suite** at `test/support/shared-storage-contract.ts` (in the source tree, not exported) that encodes every behavioral guarantee above. Custom adapters are encouraged to copy it into their own repo and plug in via `describeStorageContract('MyStorage', factory)` to catch LSP drift before it ships.

## IETF draft-compatible profile

This package targets the behavior described by [`draft-ietf-httpapi-idempotency-key-header-07`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/). The draft is not a final RFC, so the package documents its supported profile explicitly. As of v0.4.0 it covers:

- ✅ `Idempotency-Key` header recognition (configurable name)
- ✅ Custom application key resolvers for webhook event ids and command ids
- ✅ Atomic key creation with NX semantics (built-in adapters)
- ✅ **Token-based compare-and-set** on every mutation — a slow caller whose record was evicted by TTL cannot clobber a newer caller's record
- ✅ Response replay for completed requests (matching fingerprint)
- ✅ **409 Conflict** only when the winner is genuinely still in flight (not for lost races against already-completed winners)
- ✅ **422 Unprocessable Entity** for fingerprint mismatch — priority over PROCESSING state per draft semantics
- ✅ Configurable completed replay TTL and optional processing TTL with boundary validation (positive integer only)
- ✅ **Per-endpoint key scoping by actual request path** — the draft's "(key, request URI)" recommendation is implemented as `HTTP_METHOD /actual/path::rawKey`, excluding the query string to avoid accidental key drift
- ✅ Binary response detection — Buffer, typed arrays, and Node/Web streams are bypassed rather than cached as JSON garbage
- ✅ Safe response header replay for `Content-Type`, `Location`, `ETag`, `Cache-Control`, and custom `X-*` headers
- ✅ Outcome observability via `onEvent` and `Idempotency-Status` headers
- ✅ **Transient storage-write failures** do NOT cause duplicate execution — a failing `complete()` is caught and the handler's response is still emitted to the caller

Deferred to future versions:

- 🚧 Transactional integration (`@TransactionalIdempotent`)
- 🚧 Dual ESM/CJS build
- 🚧 Business-error caching option
- 🚧 Swagger/OpenAPI integration

## Caveats

- **Body fingerprint uses stable JSON serialization.** Object keys are sorted recursively before hashing, so semantically equivalent JSON objects with different key order produce the same fingerprint. Array order remains significant.
- **Custom fingerprints are caller-defined.** A resolver must be deterministic for the same semantic request. Non-deterministic values such as timestamps or random ids will cause false 422 mismatches.
- **Processing TTL is a lease, not a transaction.** A short `processingTtl` helps recover stuck records, but if it is shorter than real handler execution time, a retry can acquire the key while the first request is still running.
- **Only plain-JSON responses are cached.** Buffers, typed arrays, Node streams, and Web `ReadableStream` are actively detected and bypass caching with a logged warning — the handler still runs and the caller still gets the response, but there is no replay for binary endpoints.
- **TTL-expiry race is closed via token-based CAS.** A slow request whose PROCESSING record has been evicted by TTL cannot clobber a newer request's record under the same key — the storage refuses the write and the interceptor logs a `stale token` warning while still emitting the handler's response to the caller.

## Roadmap

- v0.2 (shipped): PostgreSQL storage adapter (`pg`), opt-in sweep service, bundled SQL DDL
- v0.3 (shipped): Stable JSON fingerprinting, safe response header replay, Fastify verification, real Redis smoke coverage, hardened release validation
- v0.4 (in progress): Processing leases, custom key resolvers, custom fingerprint resolvers, observability events/status headers, draft-compatible documentation cleanup
- v0.5 candidates: Transactional integration (`@TransactionalIdempotent`), business-error caching option, Swagger/OpenAPI integration, service-level idempotency helpers

## License

MIT — see [LICENSE](./LICENSE).
