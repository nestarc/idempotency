# NestJS HTTP Idempotency — @nestarc/idempotency

Prevent duplicate HTTP request handling in NestJS applications with `Idempotency-Key`,
response replay and request fingerprint validation. This TypeScript package supports
Express and Fastify, with Redis, PostgreSQL and in-memory storage adapters.

[![CI](https://github.com/nestarc/idempotency/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nestarc/idempotency/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@nestarc/idempotency.svg)](https://www.npmjs.com/package/@nestarc/idempotency)
[![license](https://img.shields.io/npm/l/@nestarc/idempotency.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.x%20%7C%2011.x-ea2845.svg)](https://nestjs.com/)

> **Version 1.0.** Upgrading from 0.4 changes adapter imports, storage formats and
> runtime support. Follow the [upgrade procedure](#upgrading-from-04-to-10)
> before deploying. The [0.4.0 documentation](https://github.com/nestarc/idempotency/blob/v0.4.0/README.md)
> remains available for applications on that version.

[Install](#install) · [Quick start](#quick-start) · [Supported versions](#supported-versions) ·
[Storage adapters](#storage-adapters) · [Configuration](#configuration-reference) ·
[Upgrade from 0.4](#upgrading-from-04-to-10) · [Validation](#validation-and-release-evidence)

## Why

HTTP mutations (such as `POST` and `PATCH`) can be processed multiple times when:

- A client times out and the user retries the request
- An API gateway or load balancer auto-retries
- A flaky mobile network resends a request without realizing the first attempt succeeded
- A service retries an HTTP call after losing the response

These retries can cause double charges and duplicate orders. A client supplies an
`Idempotency-Key` identifying one intended operation. While its completed response
is retained, a matching retry receives that response without running the handler
again. An in-flight duplicate receives 409; reusing the key with a different
request fingerprint receives 422.

`@nestarc/idempotency` provides a NestJS decorator API and pluggable storage for the [supported profile](#ietf-draft-compatible-profile) below. It does not implement every draft requirement. It does not claim full exactly-once execution across your business database transaction; it protects the HTTP mutation boundary and uses token-CAS storage records to prevent stale writers from clobbering newer records.

Use it for HTTP payment commands, order creation and webhook handlers, together
with durable business IDs and application authorization. It does not intercept
message-broker consumers or background jobs.

## Install

Install the 1.0 package in a NestJS application running a
[supported Node and Nest version](#supported-versions):

```bash
npm install '@nestarc/idempotency@^1.0.0'
```

If you plan to use the Redis storage adapter, also install `ioredis`:

```bash
npm install 'ioredis@^5'
```

If you plan to use the PostgreSQL storage adapter, install `pg` and its
TypeScript declarations (for TypeScript consumers):

```bash
npm install 'pg@^8.11'
npm install --save-dev '@types/pg@^8.11'
```

Memory needs neither database driver nor database type package. Redis includes
its own declarations and needs no PostgreSQL packages. These are optional peers;
install only the driver you use, alongside your application's Nest common/core,
reflect-metadata and rxjs dependencies.

### Public imports

| Import path | Public API | Additional dependency |
| --- | --- | --- |
| `@nestarc/idempotency` | Module, interceptor, decorator, MemoryStorage, tokens and common types | None beyond Nest peers |
| `@nestarc/idempotency/redis` | RedisStorage, RedisStorageOptions | `ioredis ^5` |
| `@nestarc/idempotency/postgres` | PostgresStorage, PostgresStorageOptions, PostgresSweepService, SweepOptions | `pg ^8.11`, and `@types/pg ^8.11` for TypeScript |
| `@nestarc/idempotency/sql/init.sql` | Schema file, located with `require.resolve()` | None |
| `@nestarc/idempotency/package.json` | Package metadata | None |

From 0.4, move Redis/Postgres classes and adapter option types out of root imports
to the paths above. Move the sweep service and SweepOptions to `/postgres` too.
Memory and common imports stay the same. Internal `dist/*` and storage-barrel
paths are not public exports. Follow the [upgrade procedure](#upgrading-from-04-to-10)
before changing a deployment from 0.4 to 1.0.

The root also exports `IdempotencyKeyResolver`, `IdempotencyFingerprintInput`,
`IdempotencyFingerprintResolver`, `IdempotencyEvent`, `IdempotencyOutcome` and
`IdempotencyObservabilityOptions`, plus `IdempotencyEventError` and
`IdempotencyStorageOperation`. Use `import type` for these interfaces and callbacks.

## Supported versions

| Component | 1.0 support |
| --- | --- |
| Node.js | 22 or 24; Node 20 is no longer supported |
| NestJS | 10 or 11, with the matching Express or Fastify adapter |
| TypeScript | 5.7.3 is the validated consumer baseline |
| Package format | CommonJS; no separate ESM build |
| Redis driver | `ioredis ^5.0.0`, optional |
| PostgreSQL driver | `pg ^8.11.0`, optional; TypeScript also needs `@types/pg ^8.11.0` |
| Nest peers | `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs` |

Consumer declarations are checked with `strict: true` and
`skipLibCheck: false`. CommonJS consumers are checked with `moduleResolution`
`node` (module `CommonJS`), `node16` (module `Node16`) and `nodenext` (module
`NodeNext`), with package type `commonjs`. The package still ships CommonJS only;
ESM builds and bundler resolution are outside this validation scope.

CI and release validation require both real PostgreSQL 16 and Redis 7, reject skipped tests,
and install the same tarball into isolated Memory/Redis/Postgres consumers.
Optional driver lower bounds (`ioredis` 5.0.0, `pg` and `@types/pg` 8.11.0) and
representative versions are tested separately. Exact dependency pins, evidence
and untested environments are recorded in [S8](https://github.com/nestarc/idempotency/blob/main/docs/1.0.0/work-items/S8-release-validation.md).

## Quick start

This is a local replay demonstration. For real mutations, use the
[payments, orders and webhook recipes](https://github.com/nestarc/idempotency/blob/main/docs/adoption-recipes.md) with durable
business IDs and authentication.

```ts
// app.module.ts
import { Body, Controller, Module, Post, UseInterceptors } from '@nestjs/common';
import {
  Idempotent, IdempotencyInterceptor, IdempotencyModule, MemoryStorage,
} from '@nestarc/idempotency';

@Controller('payments')
@UseInterceptors(IdempotencyInterceptor)
class PaymentsController {
  @Post()
  @Idempotent()
  createPayment(@Body() dto: { commandId: string; amount: number }) {
    // Demo only: no money is moved. Validate DTOs in your application.
    return { commandId: dto.commandId, amount: dto.amount, accepted: true };
  }
}

@Module({
  imports: [IdempotencyModule.forRoot({ storage: new MemoryStorage(), ttl: 86400 })],
  controllers: [PaymentsController],
})
export class AppModule {}
```

```ts
// main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT run Nest lifecycle hooks
  await app.listen(3000);
}
void bootstrap();
```

```sh
# Send twice: the second response has Idempotency-Status: replayed.
curl -i http://localhost:3000/payments -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-command-1' -d '{"commandId":"demo-command-1","amount":100}'
```

The [executable examples](https://github.com/nestarc/idempotency/blob/main/test/consumers/README.md) compile public imports from an
installed tarball and exercise Nest init/close, first request and replay.
Memory is local to one process and loses records on restart.

A duplicate `POST /payments` with the same `Idempotency-Key` header and matching
body replays a retained, supported completed response without re-running your
handler. A processing lease returns 409. Failures, cancellation and expiry need
the [failure and recovery contract](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md).

### Three ways to wire the interceptor

The module deliberately does **not** auto-register the interceptor. The following
are changes to the quickstart above; the controller/method examples are placement
fragments. Complete compiled versions are in the [Memory examples](https://github.com/nestarc/idempotency/blob/main/test/consumers/memory/examples.ts).

```ts
// 1. App-global — replace the quickstart module and remove its @UseInterceptors.
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor, IdempotencyModule, MemoryStorage } from '@nestarc/idempotency';

@Module({
  imports: [IdempotencyModule.forRoot({ storage: new MemoryStorage() })],
  controllers: [PaymentsController], // the quickstart controller above
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

### Response replay contract

Register idempotency **before** every interceptor that transforms the response.
[Nest executes the outgoing chain in reverse order](https://docs.nestjs.com/faq/request-lifecycle#interceptors), so idempotency then captures
the transformed value. For example:

```ts
import { ClassSerializerInterceptor, UseInterceptors } from '@nestjs/common';

@UseInterceptors(IdempotencyInterceptor, ClassSerializerInterceptor)
@Idempotent()
@Post()
createPayment() { /* return a DTO or a Promise of one */ }
```

For global registration, put the `APP_INTERCEPTOR` provider for
`IdempotencyInterceptor` before the one for `ClassSerializerInterceptor`.
A global serializer with controller/method-scoped idempotency has the wrong order.
With the supported order, `@Exclude()` is applied before storage and `@Transform()`
(including `@SerializeOptions({ type: ... })`) is not applied again on replay.
The library cannot detect arbitrary outer response transformations; the ordering
requirement also applies to custom interceptors and adapter serialization hooks.
Adapter-specific response schemas or serializers that further transform the body
are outside this replay contract.

| Response path | Behavior with `@Idempotent()` |
| --- | --- |
| Plain JSON, or a Promise of it | Capture status, body and allowed headers; replay without calling the handler. |
| Ordinary HTTP Observable | Wait for successful completion, then capture only the last value. `EMPTY` is an empty (`undefined`) successful response. |
| `@Res({ passthrough: true })` | Supported when setting status/headers and returning a JSON value. |
| Class instances reaching idempotency, `Date`, `StreamableFile`, binary/streams, or other unsupported values | Pass the original value to Nest, emit `bypassed`, retain the existing PROCESSING lease; retries receive 409 during the lease. |
| Passthrough handler already called `send()` | Keep the response already sent and retain the lease; do not write extra headers after send. |
| Direct `@Res()`/`@Next()` without passthrough, `@Render()`, `@Redirect()` | Configuration error 500 before handler or storage access, on every request. |
| SSE | Unsupported. Handler and storage are not called. Nest may already have opened HTTP 200, then send an error event and close the stream. |

Supported JSON consists of null, strings, booleans, finite numbers, normal arrays,
and recursively plain or null-prototype objects. Root `undefined` is an empty
body. Convert dates to strings before this boundary. Nested `undefined`, class
instances, custom prototypes, sparse arrays, accessors, `toJSON`, proxies,
functions, symbols, BigInt and circular values are excluded. Nonenumerable data
properties are ignored. A wrong-order class response is bypassed rather than
cached with its serialization metadata lost, but not every ordering mistake is
detectable from a plain object.

An unsupported response is still subject to Nest/adapter handling: passing it
through cannot make an invalid HTTP body valid. A retained lease only protects
until `processingTtl` expires; retrying after expiry can execute the operation
again. A source error discards intermediate values and uses token-based error
cleanup, even if business effects already committed. Subscription cancellation
does not start completion or deletion for a later handler result; an already
started storage Promise may still commit. See [failure recovery](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md).

### Upgrading from 0.4 to 1.0

All scope modes now use versioned storage keys; old raw and `scope::key` records
have no fallback lookup, automatic move or deletion. Response bodies
also use a versioned opaque string, including empty bodies. Custom adapters must
preserve it exactly. A legacy/corrupt body found under a **current-format key**
returns 409 without replay or re-execution (a fingerprint mismatch takes priority
with 422). There is no SQL schema change.

**Changing the key format can execute an old operation again. Pausing traffic
and draining requests alone does not prevent this.** Before switching, protect
past commands with a durable business/inbox unique ID, or reconcile business
results and block past retries upstream. If that protection is unavailable,
postpone the switch until all possible redeliveries and uncertain operations
have been resolved. Cache TTL expiry does not prove that a retry is safe.

Use a separate, verified empty storage namespace (a fresh MemoryStorage,
Redis `keyPrefix`, Postgres `tableName`, or separate store). Old global/resolver
keys were arbitrary strings and could equal a new encoded key: the version
prefix alone does not prove record provenance. A coincident key with an
S1-compatible body could otherwise replay an old response. Co-residence of old
and new key formats in the same namespace is unsupported. Namespace isolation
prevents old response mixing; business deduplication separately prevents repeats.

Old/new writers must not overlap. Pause protected traffic, resolve in-flight
work, verify business deduplication and the empty separate namespace, replace all
instances, then resume. Rollback requires the same protection for commands
processed by the new version; old code cannot read the new keys or bodies.
Do not use automatic dual reads, key rotation alone or bulk deletion as a migration.
Old records generally cannot prove the tenant/user authorization required by
the new scope. Follow the [executable migration and rollback guide](https://github.com/nestarc/idempotency/blob/main/docs/migration-1.0.md) and
[D07](https://github.com/nestarc/idempotency/blob/main/docs/1.0.0/decisions.md#d07--10-전환과-롤백-decided).

## Redis storage

```ts
import { Module } from '@nestjs/common';
import { IdempotencyModule } from '@nestarc/idempotency';
import { RedisStorage } from '@nestarc/idempotency/redis';
import Redis from 'ioredis';

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

Here `client` belongs to the application. After `await app.close()`, its owner
must call `await client.quit()` once, after all users have stopped. The adapter
does not close an injected client. See [Redis lifecycle examples](https://github.com/nestarc/idempotency/blob/main/test/consumers/redis/examples.ts).

### Async registration and connection ownership

For an adapter-owned connection, use `connection`. Nest calls the adapter's
shutdown hook when closing the application:

```ts
import { Module } from '@nestjs/common';
import { IdempotencyModule } from '@nestarc/idempotency';
import { RedisStorage } from '@nestarc/idempotency/redis';

@Module({
  imports: [IdempotencyModule.forRootAsync({
    useFactory: async () => ({
      storage: new RedisStorage({
        connection: {
          host: process.env.REDIS_HOST ?? '127.0.0.1',
          port: Number(process.env.REDIS_PORT ?? 6379),
        },
      }),
      ttl: 86400,
      processingTtl: 60,
    }),
  })],
})
export class AppModule {}
```

For dependency injection, list the supplying module in `imports` and its tokens
in `inject`. `useClass` constructs an `IdempotencyOptionsFactory`; `useExisting`
uses an exported factory from an imported module. Choose one async mechanism.
The [compiled async examples](https://github.com/nestarc/idempotency/blob/main/test/consumers/common/module-examples.ts) exercise all
three mechanisms, including import visibility and init/close.

| Construction | Connection owner and shutdown |
| --- | --- |
| `new MemoryStorage()` | Nest destroys its timers on `app.close()`. |
| `new RedisStorage({ client })` | Application owner quits the shared client after all users close. |
| `new RedisStorage({ connection })` | Adapter quits its own client on module destroy. |
| `new PostgresStorage({ pool })` | Application owner ends the shared pool after all users close. |
| `new PostgresStorage({ connection })` | Adapter ends its own pool on module destroy. |

Register each storage instance once. Avoid separate adapters or pools for the
interceptor and sweep service. If startup fails, the application still owns
cleanup of resources it created. `app.close()` triggers lifecycle hooks;
`enableShutdownHooks()` additionally connects process signals to that lifecycle.

## PostgreSQL storage

If your stack already runs Postgres, you can avoid adding Redis just for
idempotency. The Postgres adapter ships with the same atomic-NX +
token-CAS guarantees as Redis, with lazy expiration on `get()` and an
optional sweep service for active cleanup.

**Create the table before starting the application.** Automatic schema creation
is disabled by default. Apply the bundled SQL or use one of the
[schema setup options](#schema-migration) below, then register the adapter:

```ts
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { IdempotencyModule } from '@nestarc/idempotency';
import { PostgresStorage } from '@nestarc/idempotency/postgres';

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

The injected `pool` remains usable after `await app.close()`; its application
owner then calls `await pool.end()`. [Postgres lifecycle examples](https://github.com/nestarc/idempotency/blob/main/test/consumers/postgres/examples.ts)
verify both injected and adapter-owned pools against a real database.

### Schema migration

Three options, pick whichever fits your tooling:

1. **SQL file (recommended for production):**
   ```bash
   psql "$DATABASE_URL" -f "$(node -p "require.resolve('@nestarc/idempotency/sql/init.sql')")"
   ```
2. **Code helper (good for tests / scripts):**
   ```ts
   import { PostgresStorage } from '@nestarc/idempotency/postgres';
   await PostgresStorage.createSchema(pool);
   ```
3. **Auto on module init (development only):**
   ```ts
   new PostgresStorage({ pool, autoCreateSchema: true });
   ```

The bundled SQL creates `idempotency_records`. For a custom `tableName`, apply
a matching migration or call `PostgresStorage.createSchema(pool, tableName)`.
Use the same table name when constructing the adapter.

The 0.4 → 1.0 upgrade does not change the SQL schema, but requires the separate
empty namespace and business deduplication described in the [upgrade procedure](#upgrading-from-04-to-10).
Legacy 0.2 tables that never received the 0.3 migration also need the response
header column:

```sql
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS response_headers JSONB;
```

### Optional sweep service

Lazy expiration on `get()` already guarantees correctness. The sweep
service exists only to bound disk usage in long-running deployments:

```ts
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import {
  IdempotencyModule,
  IDEMPOTENCY_SWEEP_OPTIONS,
} from '@nestarc/idempotency';
import { PostgresStorage, PostgresSweepService } from '@nestarc/idempotency/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

`PostgresSweepService` injects `IDEMPOTENCY_STORAGE`, so it uses the exact
`PostgresStorage` instance registered by `forRoot` or `forRootAsync`. Register
this service only with PostgreSQL storage. Its timer stops on Nest close; the
external pool still belongs to the application. [The executable sweep example](https://github.com/nestarc/idempotency/blob/main/test/consumers/postgres/examples.ts)
checks expiration cleanup, active-row retention and pool ownership.

Or schedule it externally with `pg_cron` (an independently installed extension):

```sql
SELECT cron.schedule('idempotency-sweep', '* * * * *',
  $$DELETE FROM idempotency_records WHERE expires_at < now()$$);
```

> Each service sweep takes a session advisory lock on the same PostgreSQL database;
> overlapping service sweeps skip while another holds it. This does not elect a
> permanent leader or coordinate the independent `pg_cron` query.

## Configuration reference

### Module options (`IdempotencyModule.forRoot(...)`)

| Option          | Type                                           | Default             | Description                                                                         |
| --------------- | ---------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `storage`       | `IdempotencyStorage`                           | (required)          | A storage adapter instance (e.g. `new MemoryStorage()`).                            |
| `ttl`           | `number` (seconds)                             | `86400`             | Completed replay record TTL. Per-handler can override.                              |
| `processingTtl` | `number` (seconds)                             | same as `ttl`       | Optional in-flight PROCESSING record TTL.                                           |
| `headerName`    | `string`                                       | `'Idempotency-Key'` | HTTP header carrying the key. Defaults to the IETF draft header name.               |
| `keyResolver`   | `(ctx) => string \| undefined \| Promise<...>` | header lookup       | Resolve keys from webhook event ids, command ids, or other application values.      |
| `maxKeyLength`  | `number`                                       | `255`               | Maximum accepted key length in UTF-8 bytes; positive safe integer.                                                        |
| `fingerprint`   | `boolean \| resolver`                          | `true`              | Compute a SHA-256 body fingerprint or provide a semantic custom fingerprint.         |
| `scope`         | `IdempotencyScope`                             | `'endpoint'`        | How storage keys are namespaced. See [Scope](#scope) below.                         |
| `replayHeaders` | `boolean \| string[]`                          | `true`              | Replay the default safe allowlist, an explicit allowlist, or disable header replay. |
| `observability` | `{ onEvent?, exposeStatusHeaders? }`           | status headers on   | Emit outcome events and expose `Idempotency-Status` headers.                        |
| `isGlobal`      | `boolean`                                      | `true`              | Register as a NestJS global module.                                                 |

#### Scope

The `scope` option controls which requests can share a replayed response.
Every mode uses a versioned SHA-256 key derived from a JSON tuple; separators in
identity, path or key cannot change component boundaries.

| Value | Behavior |
| --- | --- |
| `'endpoint'` | **Default.** Includes the HTTP method and actual path, including path parameter values. Does not infer an authenticated identity. |
| `'global'` | Shares keys across all endpoints and identities using this storage. Use only when every caller is authorized to share every response. |
| function | Returns a nonblank string or a nonempty `readonly string[]` of nonblank identity components. Always **adds to** method + actual path; it no longer replaces the endpoint as in 0.4. |

Actual paths preserve percent encoding and duplicate/trailing slashes, which
routers may treat as different resources. Query strings remain excluded to
avoid new executions caused by query ordering or tracking parameters. If a query
value changes the operation, include selected values in the scope array in a
stable order, or include them in a custom fingerprint to reject reuse with 422.
Custom contexts without a URL fall back to Nest route metadata, then controller
and handler names; ordinary Express/Fastify requests use their actual URL.

```ts
// Authentication/authorization guards run before interceptors on every request.
IdempotencyModule.forRoot({
  storage: new MemoryStorage(),
  scope: (ctx) => {
    const req = ctx.switchToHttp().getRequest<{
      user: { tenantId: string; id: string };
    }>();
    return [req.user.tenantId, req.user.id];
  },
});
```

Populate `req.user` from verified authentication, never from an untrusted tenant
header. Include every identity dimension whose responses must be isolated. A
Nest guard must authorize each resource before this interceptor, including on
replays and after permission revocation. Authentication or webhook signature
verification only inside the handler is bypassed on replay. For webhooks, verify
the provider signature over the original raw bytes in a guard before resolving
the event ID. The Express/Fastify
[executable guard and HMAC examples](https://github.com/nestarc/idempotency/blob/main/test/e2e/request-isolation.e2e-spec.ts)
exercise this ordering.

#### Key input

Headers carry one raw opaque string, **not a parsed Structured Field String**.
`K` and `"K"` are different keys; quoting and escapes are literal. Repeated fields,
arrays, commas (including proxy-joined fields), empty/blank strings, control
characters and unpaired Unicode surrogates return 400 before fingerprinting,
storage or handler execution. Proxies must preserve/reject duplicates rather
than silently discard them. The package does not trim, case-fold or Unicode
normalize keys; the HTTP parser may strip surrounding header whitespace.

`keyResolver` replaces header lookup entirely, accepts sync/async string or
undefined, and applies the same string checks, except that commas are allowed.
Only undefined means missing: `required: false` bypasses missing keys but still
rejects invalid keys. `maxKeyLength` counts **UTF-8 bytes**, defaults to 255 and
must be a positive safe integer. Invalid configuration is a server error (500).

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

`ttl` and `processingTtl` accept integer seconds from **1 through 2,147,483,647**
inclusive. All three adapters support 30-day windows. Invalid configuration
produces a `RangeError` at request time before storage or handler execution
(a configuration error, HTTP 500 by default). Direct adapter `create()` and
`complete()` calls reject invalid TTLs before storage access, even when the key
is missing, occupied, expired or already completed.

By default, `PROCESSING` records and completed replay records use the same
`ttl`. For long replay windows, you can use a shorter `processingTtl` so stuck
in-flight records expire sooner after a crash. Expiry permits a new acquisition;
it does not establish that the previous business operation failed:

```ts
IdempotencyModule.forRoot({
  storage: new RedisStorage({ client }),
  ttl: 86400,        // replay completed responses for 24 hours
  processingTtl: 60, // lease expires after 60 seconds; reconcile uncertain work
});
```

Choose `processingTtl` to cover the intended execution window, including slow
dependencies and pauses. Even a lease above p99 can expire while work continues.
A retry can then acquire the key and overlap the original operation. There is
no automatic heartbeat; use durable business deduplication and the
[reconciliation procedure](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md#reconcile-a-payment-command).

### Errors, timeouts and recovery

Handler errors retain the existing best-effort token-delete policy. This also
applies to a timeout inside the handler Observable; an exception after a business
commit can therefore permit another execution. A successful handler whose
response cannot be captured retains its PROCESSING lease. A failed `complete`
call preserves the successful value and never triggers handler-error cleanup.
Storage may already be COMPLETED if its write applied before acknowledgment failed.

An outer timeout or explicit unsubscribe tears down the source subscription and
does not keep a detached subscription to record later handler results. Business
Promises can continue, and already-started `create`/`complete`/`delete` Promises
can still commit without delivering events or a response. HTTP disconnects do
not necessarily unsubscribe the application chain. See the
[transition table and timeout placement guide](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md) before
enabling automatic retries. A missing record or expired lease is not evidence
that retrying a business operation is safe.

### Custom key and fingerprint resolvers

Use `keyResolver` when the stable key comes from a webhook event id or command
id instead of the `Idempotency-Key` header.

The [webhook recipe](https://github.com/nestarc/idempotency/blob/main/docs/adoption-recipes.md) verifies the original raw bytes
in a guard, validates the event, then resolves its event ID. It also separates
event deduplication from business deduplication and out-of-order delivery.
Do not resolve an event ID from an unverified body or verify only in the handler:
replay skips the handler. Keep all mutation-relevant fields in the default body
fingerprint, or explicitly select and test the semantic fields your provider
promises to keep stable.

The boolean `fingerprint` behavior remains unchanged. A custom resolver replaces
the default body hash and should return a deterministic semantic fingerprint.

### Observability

The 1.0 event contract emits optional outcome events and status headers:

```ts
import { IdempotencyModule, type IdempotencyOutcome } from '@nestarc/idempotency';
import { PostgresStorage } from '@nestarc/idempotency/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const counts = new Map<IdempotencyOutcome, number>();

IdempotencyModule.forRoot({
  storage: new PostgresStorage({ pool }),
  observability: {
    onEvent: (event) => {
      // outcome has a fixed set of values. Do not use request hashes as labels.
      counts.set(event.outcome, (counts.get(event.outcome) ?? 0) + 1);
    },
  },
});
```

Events contain `outcome`, `namespace`, `keyHash`, and optional `statusCode` and
`error`. `namespace` replaces the old `event.scope`: it is a versioned SHA-256
hash of the scope's identity and endpoint tuple, independent of the raw key.
`keyHash` is SHA-256 of the encoded storage key. Both are deterministic for the
same effective inputs and key format; changing scope or the storage key format
can change them. S3's versioned key encoding changes `keyHash` from 0.4 values.
These hashes are neither encryption nor a guarantee of anonymity: guessed
identities, paths or keys can still be correlated. Both may have high cardinality;
do not use either as a metric label. The example records only the fixed outcome.

`error` is a classification, never an original error object:

```ts
import type { IdempotencyEventError } from '@nestarc/idempotency';

// Storage failures distinguish the exact operation.
const storageError: IdempotencyEventError = {
  code: 'storage_failure',
  operation: 'race_get', // get | create | race_get | complete | delete
};
const replayError: IdempotencyEventError = { code: 'response_not_replayable' };
```

Consumers upgrading from `event.scope` must use `namespace`; consumers inspecting
`error.message`, `name`, `stack`, `cause`, or driver codes must switch to
`error.code` and, for storage failures, `error.operation`. The library does not
read or forward those original error fields into events or internal logs.
Internal failure logs use fixed messages and diagnostic codes, with generated
`namespace`/`keyHash` where available, without raw/storage keys, bodies, identity,
paths or driver errors. This also applies to PostgreSQL sweep failures.
Application exception filters, driver logs and consumer callbacks remain
responsible for what they log; original failures can still propagate through the
application error path.

| Failure | Event | Request behavior |
| --- | --- | --- |
| `get`, `create`, or race re-read (`race_get`) | One `storage_error` with its operation | Propagate the original storage failure; do not run the handler. |
| `complete` | One `complete_error` with operation `complete` | Preserve the successful handler value and do not delete the record. |
| Handler cleanup `delete` | One `storage_error` with operation `delete` | Preserve the original handler error. |
| Handler value cannot be captured for replay | One `bypassed` with `response_not_replayable` | Pass through the handler value and keep the PROCESSING lease. |
| Completed body cannot be replayed | One `conflict` without an error payload | Return 409 and keep the record. |

Synchronous storage throws and Promise rejections follow the same observation
and preservation rules. Successful cleanup and the handler error itself emit no
additional event. A failed or ambiguous write may already have changed storage;
an event is not proof of the final database state. Pending writes that settle
after unsubscribe do not deliver an outcome event through the canceled chain.
See [failure recovery](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md) for cancellation, crash and
reconciliation rules and [D06](https://github.com/nestarc/idempotency/blob/main/docs/1.0.0/decisions.md#d06--저장소-공통-계약-decided)
for the completed adapter contract.

`onEvent` is best-effort and is not awaited. A synchronous throw or asynchronous
rejection produces one fixed warning without another event, and cannot replace
the request result or trigger cleanup. Do not use the callback for business
writes whose completion the request must await.

Status headers are enabled by default for responses whose headers remain writable:

- `Idempotency-Status: created`
- `Idempotency-Status: replayed` plus `Idempotency-Replayed: true`
- `Idempotency-Status: conflict`
- `Idempotency-Status: mismatch`
- `Idempotency-Status: bypassed`, `stale`, or `complete_error` for those outcomes

`storage_error` does not assign a new HTTP status or status header. Set
`observability: { exposeStatusHeaders: false }` to disable library-generated
status headers. `Idempotency-Status` and `Idempotency-Replayed` are always excluded
from captured and replayed headers, even in an explicit `replayHeaders` allowlist;
old stored copies cannot restore them when exposure is disabled. Current-request
headers are generated from the current outcome only.

### Response header replay

The module caches and replays a conservative set of response headers by default:
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
    │     └─ resolve TTL (integer seconds 1 through 2,147,483,647)
    │
    ├─ 2. Apply scope to the key
    │     (versioned hash of identity + method + actual path + key; query excluded)
    │
    ├─ 3. Look up the scoped key in storage
    │     ├─ COMPLETED + matching fingerprint + supported body → replay
    │     ├─ COMPLETED + legacy/corrupt body       → 409 (keep record)
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
    └─ 6. Capture the final response after successful completion
          ├─ plain JSON             → storage.complete(token, statusCode, body, safe headers)
          │   ├─ 'ok'               → emit handler value
          │   ├─ 'stale'           → warn + emit (don't change storage)
          │   └─ throws/rejects    → ERROR log + emit (don't delete;
          │                            failed acknowledgment may follow a write)
          ├─ capture unavailable  → bypass + warn + emit, keep PROCESSING
          └─ handler threw         → token delete (best-effort) + original error
```

The interceptor waits for the ordinary HTTP source to complete and uses RxJS `concatMap` to await the storage write before emitting the final value. Intermediate emissions are never published as completed responses.

Storage adapters implement **token-based compare-and-set**: each `create()`
returns an opaque token passed to `complete()` / `delete()`. Completion requires
an unexpired PROCESSING record with that token. Expired, missing, replaced or
already completed records return `'stale'` without changing the response, TTL or
creation time. The active original caller still receives its handler value.
These checks protect storage ownership; they do not cancel business operations.

## Error reference

| Status | When                                                                                                                                                                   | Meaning                           |
| -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
|    400 | Required key is missing, malformed/repeated, or exceeds `maxKeyLength` UTF-8 bytes | client contract |
|    409 | The record is PROCESSING, or its completed payload is legacy/corrupt/unsupported | concurrent duplicate / safe replay unavailable |
|    422 | A record exists under this scoped key with a different request-body fingerprint (reused key with new payload)                                                          | key reused with new payload       |
|    500 | Invalid developer configuration, including unsupported manual/render/redirect response modes, TTLs, maxKeyLength or scope values | configuration error; SSE follows the stream behavior above |

When a racing winner has already finished with a supported payload and matching fingerprint, its response is replayed. The interceptor re-reads the record after a lost `create()` race and applies the same validation as on the initial read.

### Client behavior after each outcome

These rows describe errors emitted by this module; application validation and
upstream gateways can use the same HTTP status for other reasons. Keep the
command ID, identity, endpoint and intended payload stable on retries.

| Outcome | Client / operator action |
| --- | --- |
| Missing key, required route (400) | Supply the previously allocated command ID. The interceptor did not run the handler. On `required: false`, missing keys bypass protection. |
| Invalid key (400) | Fix the header/resolver contract (one nonblank key within the byte limit). Invalid keys never bypass, even on optional routes. Do not silently remap a command with an uncertain earlier attempt. |
| Processing or unreplayable stored response (409) | Use bounded backoff for known in-flight work, keeping the same key/body. Persistent 409 or an unknown prior result requires business lookup/reconciliation. No automatic `Retry-After` or wait API is supplied. |
| Fingerprint mismatch (422) | Compare the original command and payload. Restore the original payload for the same intent. Allocate a new command ID only for a deliberately new operation after resolving the old outcome; never rotate keys just to avoid 422. |
| Handler error, including an inner timeout | Cleanup attempts token deletion and a later request may run again. A 5xx does not prove rollback. Query the command ledger/provider first; retry only under durable deduplication when safe. |
| Storage get/create/race lookup error | Handler is not invoked by that attempt, but a failed create acknowledgment may leave a lease. Respect earlier uncertain attempts; fix storage and reconcile before retrying. |
| Successful response with `complete_error` or `stale` | Preserve the successful result. The replay record may be PROCESSING, COMPLETED or gone. Do not submit a new command to repair caching. Status headers may be disabled, so clients cannot require them. |
| TTL expired / record absent | The next request can execute again. Retained business/inbox IDs must still prevent duplicate effects; expiry is not evidence of failure. |
| Network timeout, outer cancellation, crash or otherwise unknown result | Query an authenticated business-result endpoint and reconcile with the provider. Hold retries while a previous worker could commit or a provider result is unknown, even after TTL. |
| Invalid TTL/scope/maxKeyLength or unsupported response configuration (default 500) | Operator fixes server configuration; changing the client key does not solve it. |

A completed response is retained for `ttl` from completion; a PROCESSING lease
lasts `processingTtl` from acquisition. Neither duration is a business transaction
or the retention period of the command ledger. See [failure recovery](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md)
and [adoption recipes](https://github.com/nestarc/idempotency/blob/main/docs/adoption-recipes.md) for reconciliation examples.

## Storage adapters

Use `MemoryStorage` for local development and tests. For multiple application
instances, use Redis or PostgreSQL with one shared storage namespace. Choose the
service whose retention and failure behavior you can operate and monitor.

| Feature          | `MemoryStorage`        | `RedisStorage`         | `PostgresStorage`                        |
| ---------------- | ---------------------- | ---------------------- | ---------------------------------------- |
| Scope            | single process         | shared across replicas | shared across replicas                   |
| Persistence      | none (lost on restart) | depends on Redis configuration | depends on Postgres configuration |
| TTL mechanism    | deadline checks + chunked timers | Redis `EXPIRE` | deadline checks + optional sweep service |
| Cross-process coordination | none | atomic NX/token CAS on one shared keyspace | atomic NX/token CAS on one shared table |
| Deployment use | dev/test only | configure retention, persistence and failover for your application | configure backups, replication and failover for your application |
| Required peer    | none                   | `ioredis ^5`           | `pg ^8.11`                               |

Persistence and failover durability depend on the deployed service configuration.
Storage coordination does not atomically commit with your business database or
external provider. Losing or expiring records can permit execution again.

### Adapter options

Pass these options to the storage constructor, separately from module options:

| Adapter | Option | Default / behavior |
| --- | --- | --- |
| Redis | `client` or `connection` | Supply an application-owned ioredis client or options for an adapter-owned connection. |
| Redis | `keyPrefix` | `idempotency:`; use a distinct prefix for separate applications or a 1.0 migration. |
| PostgreSQL | `pool` or `connection` | Supply an application-owned pg pool or options for an adapter-owned pool. |
| PostgreSQL | `tableName` | `idempotency_records`; provision a matching table before use. |
| PostgreSQL | `autoCreateSchema` | `false`; opt in only when automatic DDL is appropriate, such as local development. |

Keep the chosen prefix or table consistent across instances serving the same
operations. The connection lifecycle is described under
[connection ownership](#async-registration-and-connection-ownership).

### Custom storage adapters

Implement the `IdempotencyStorage` interface. Treat a lease at or past its storage
deadline as absent in every operation, regardless of physical cleanup. Memory/PG
use `expiresAt <= now`; Redis uses server TTL, with client-clock `expiresAt` metadata. The contract is **token-based
compare-and-set**: `create()` returns an opaque token, and mutations cannot
change a live record belonging to another token. `complete()` additionally
requires PROCESSING and must leave an already completed record unchanged.
Before any lookup or mutation, `create()` and `complete()` must reject TTLs
outside the integer range `[1, 2_147_483_647]` with `RangeError`. Do not coerce
strings, clamp values, or let an NX/CAS miss hide an invalid TTL. Implementations
must support the whole range; native timers may need to split long deadlines
into smaller waits. This contract validates TTLs, not every record field.

Import `IdempotencyStorage`, `IdempotencyRecord`, `CreateResult`,
`CompleteResponse` and `MutateResult` as types from `@nestarc/idempotency`.
Implement `get/create/complete/delete` with the contract above, preserve the
opaque response body exactly, then supply that instance as `storage` to
`forRoot` or the async options factory. An optional `onModuleDestroy` hook must
close only resources owned by the adapter.

The repository includes a [shared storage contract suite](https://github.com/nestarc/idempotency/blob/main/test/support/shared-storage-contract.ts)
covering TTL boundaries, record ownership, completion and deletion. It is source
test code, not part of the npm package. Custom adapter authors can reuse
`describeStorageContract('MyStorage', factory)`; the factory supplies `storage`,
`expire` and `cleanup` as documented in that file. Add adapter-specific tests for
real concurrency, persistence and connection failures as well.

## IETF draft-compatible profile

This profile is based on the fixed [draft-07 text](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.html), checked 2026-10-07. That document expired on 2026-04-18; it is not a final RFC or a claim of conformance to a later revision. The 1.0 profile covers:

- ✅ `Idempotency-Key` header recognition (configurable name); raw opaque strings, not Structured Field parsing
- ✅ Custom application key resolvers for webhook event ids and command ids
- ✅ Atomic key creation with NX semantics (built-in adapters)
- ✅ **Token-based compare-and-set** on every mutation — a slow caller whose record was evicted by TTL cannot clobber a newer caller's record
- ✅ Response replay for completed requests (matching fingerprint)
- ✅ **409 Conflict** for in-flight requests and stored response formats that cannot be safely replayed
- ✅ **422 Unprocessable Entity** for fingerprint mismatch — priority over PROCESSING state per draft semantics
- ✅ Configurable completed replay TTL and optional processing TTL (integer seconds 1–2,147,483,647, including direct adapter validation)
- ✅ **Per-endpoint key scoping by actual request path** — versioned hash of a tuple containing method, actual path and raw key, plus identity for custom scopes; query excluded
- ✅ Binary response detection — Buffer, typed arrays, and Node/Web streams are bypassed rather than cached as JSON garbage
- ✅ Safe response header replay for `Content-Type`, `Location`, `ETag`, `Cache-Control`, and custom `X-*` headers
- ✅ Outcome observability via `onEvent` and `Idempotency-Status` headers
- ✅ **Completion failure isolation** — a failing `complete()` preserves the handler's successful value and never triggers deletion; uncertain writes and retries after expiry require business reconciliation

Differences from draft-07: header values are raw opaque strings, with no
Structured Field parsing; quotes are literal. Handler exceptions are not cached.
Errors use Nest exceptions, without automatic `application/problem+json`, a
`Link` header or an application documentation URL. Applications publish their
own key, expiry and retry policies. Streams, SSE and manual responses are outside
the supported replay profile. A decorator does not make an operation exactly-once.

Transactional integration, a dual ESM/CJS build, business-error caching and
automatic Swagger/OpenAPI integration are outside the current API.

## Caveats

- **Body fingerprint uses stable JSON serialization.** Object keys are sorted recursively before hashing, so semantically equivalent JSON objects with different key order produce the same fingerprint. Array order remains significant.
- **Custom fingerprints are caller-defined.** A resolver must be deterministic for the same semantic request. Non-deterministic values such as timestamps or random ids will cause false 422 mismatches.
- **Processing TTL is a lease, not a transaction.** A short `processingTtl` helps recover stuck records, but if it is shorter than real handler execution time, a retry can acquire the key while the first request is still running.
- **Replay requires the supported response boundary.** Register idempotency before response transformers. Unsupported values retain their PROCESSING lease and are not replayed; see the response contract and upgrade procedure above.
- **Token CAS protects record ownership.** Expired or replaced requests cannot complete a newer record, and repeated completion cannot overwrite an established response. Work may still overlap after lease expiry; see the [failure and recovery guide](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md).

## Validation and release evidence

The [test guide](https://github.com/nestarc/idempotency/blob/main/test/README.md) records the 2026-10-07 audit, reviewed files and
validation limits. Two source environments—Node 24 / Nest 11 with representative
drivers and Node 22 / Nest 10 with minimum supported drivers—each passed **46 suites
and 1,093 tests with zero skips**, using real PostgreSQL 16 and Redis 7. Installed
tarball consumers separately checked public imports, strict declarations and real
Memory/Redis/Postgres HTTP behavior. Seven selected source mutation probes failed
the expected assertions; this is evidence for those checks, not a guarantee that
all defects are detected.

The [release workflow](https://github.com/nestarc/idempotency/blob/main/.github/workflows/release.yml) requires all eight Node
22/24 × Nest 10/11 × minimum/representative peer combinations to validate one
tarball before publication. It checks the test inventory, rejects skips and
verifies artifact checksums. The two audit environments above do not replace that
complete release matrix. [S8](https://github.com/nestarc/idempotency/blob/main/docs/1.0.0/work-items/S8-release-validation.md)
records the release procedure and prior evidence.

The [2026-10-07 CI run](https://github.com/nestarc/idempotency/actions/runs/37633224775)
passed all eight combinations and the final artifact gate for commit `2d0af38`.
Each release tag runs the full gate again for its own commit and tarball.

Tagged releases are configured to publish the verified tarball through npm
Trusted Publishing with provenance. Verify the attestation on the **specific
published npm version**; workflow configuration alone does not attest an
unpublished build. Benchmarks have separate [reproduction instructions and
measurement limits](https://github.com/nestarc/idempotency/blob/main/bench/README.md).

## Documentation and contributing

- [Changelog](./CHANGELOG.md): breaking changes and version history.
- [Adoption recipes](https://github.com/nestarc/idempotency/blob/main/docs/adoption-recipes.md): payments, orders and signed webhooks.
- [Failure and recovery](https://github.com/nestarc/idempotency/blob/main/docs/failure-recovery.md): cancellation, storage outages and reconciliation.
- [Upgrade and rollback](https://github.com/nestarc/idempotency/blob/main/docs/migration-1.0.md): the 0.4 → 1.0 transition.
- [Contributing](https://github.com/nestarc/idempotency/blob/main/CONTRIBUTING.md): development, tests and release checks.
- [Report a bug](https://github.com/nestarc/idempotency/issues/new?template=bug_report.yml): include versions and a minimal reproduction; remove secrets and customer data.

Extended guides, tests and benchmark sources live in the repository; npm includes
this README, the changelog, license, compiled package and SQL schema. Source links
target the repository's `main` branch. For an older installed version, use the
documentation under its matching Git tag, such as the 0.4 documentation above.

## License

MIT — see [LICENSE](./LICENSE).
