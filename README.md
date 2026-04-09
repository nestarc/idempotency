# @nestarc/idempotency

> IETF-draft-compliant idempotency module for NestJS — decorator-based, pluggable storage (memory/Redis), response replay, fingerprint validation.

[![npm version](https://img.shields.io/npm/v/@nestarc/idempotency.svg)](https://www.npmjs.com/package/@nestarc/idempotency)
[![license](https://img.shields.io/npm/l/@nestarc/idempotency.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.x%20%7C%2011.x-ea2845.svg)](https://nestjs.com/)

## Why

Non-idempotent HTTP methods (`POST`, `PATCH`, `DELETE`) can be processed multiple times when:

- A client times out and the user retries the request
- An API gateway or load balancer auto-retries
- A flaky mobile network resends a request without realizing the first attempt succeeded
- Microservices duplicate messages between hops

The result is double charges, duplicate orders, and corrupt state. The IETF draft [`httpapi-idempotency-key-header-07`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) standardizes a solution: clients send an `Idempotency-Key` header with a unique value, and the server enforces "exactly-once" semantics by replaying the original response on retries.

`@nestarc/idempotency` is a clean-room NestJS implementation of that draft, with a one-line decorator API and pluggable storage.

## Install

```bash
npm install @nestarc/idempotency
```

If you plan to use the Redis storage adapter, also install `ioredis`:

```bash
npm install ioredis
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

## Configuration reference

### Module options (`IdempotencyModule.forRoot(...)`)

| Option        | Type                | Default            | Description                                                  |
| ------------- | ------------------- | ------------------ | ------------------------------------------------------------ |
| `storage`     | `IdempotencyStorage` | (required)        | A storage adapter instance (e.g. `new MemoryStorage()`).      |
| `ttl`         | `number` (seconds)  | `86400`            | Default time-to-live for records. Per-handler can override.  |
| `headerName`  | `string`            | `'Idempotency-Key'`| HTTP header carrying the key. Defaults to the IETF standard. |
| `fingerprint` | `boolean`           | `true`             | Compute a SHA-256 fingerprint of the request body.           |
| `isGlobal`    | `boolean`           | `true`             | Register as a NestJS global module.                          |

### Decorator options (`@Idempotent(options?)`)

| Option        | Type      | Default | Description                                                                          |
| ------------- | --------- | ------- | ------------------------------------------------------------------------------------ |
| `required`    | `boolean` | `true`  | If true and the header is missing, the interceptor returns 400. If false, pass-through. |
| `ttl`         | `number`  | inherit | Override the module-level TTL for this handler (seconds).                             |
| `fingerprint` | `boolean` | inherit | Override the module-level fingerprint setting.                                        |

## How it works

```
Client Request (with Idempotency-Key header)
    │
    ▼
[IdempotencyInterceptor]
    │
    ├─ 1. Read Idempotency-Key header
    │     └─ missing + required=true → 400 Bad Request
    │
    ├─ 2. Look up the key in storage
    │     ├─ COMPLETED (fingerprint match) → replay cached response
    │     ├─ COMPLETED (fingerprint mismatch) → 422 Unprocessable Entity
    │     ├─ PROCESSING → 409 Conflict
    │     └─ not found → continue to step 3
    │
    ├─ 3. Atomically create a PROCESSING record (lock)
    │     └─ lost race → 409 Conflict
    │
    ├─ 4. Run the controller handler
    │
    └─ 5. Capture the response and store it as COMPLETED
         └─ on error: delete the key (allow retry)
```

The interceptor uses RxJS `concatMap` to ensure the storage write completes **before** the response is emitted to the client — preventing a race window where a duplicate request arriving microseconds later could observe the wrong state.

## Error reference

| Status | When                                                                       | IETF rationale            |
| -----: | -------------------------------------------------------------------------- | ------------------------- |
|    400 | `Idempotency-Key` header is missing and `required: true` (the default)     | client contract violation |
|    409 | A record with this key is currently `PROCESSING`, or `create` lost a race  | concurrent duplicate      |
|    422 | A record exists with this key but the request body fingerprint differs    | key reused with new payload |

## Storage adapters

| Feature                | `MemoryStorage`              | `RedisStorage`                          |
| ---------------------- | ---------------------------- | --------------------------------------- |
| Scope                  | single process               | shared across replicas                  |
| Persistence            | none (lost on restart)       | full Redis durability                   |
| TTL mechanism          | `setTimeout`                 | Redis `EXPIRE`                          |
| Cluster-safe           | ❌                           | ✅                                      |
| Production-ready       | ❌ (dev/test only)           | ✅                                      |
| Required peer          | none                         | `ioredis ^5`                            |

### Custom storage adapters

Implement the `IdempotencyStorage` interface:

```ts
import type { IdempotencyStorage } from '@nestarc/idempotency';

class MyStorage implements IdempotencyStorage {
  async get(key) { ... }
  async create(key, fingerprint, ttlSeconds) { ... }
  async complete(key, response, ttlSeconds) { ... }
  async delete(key) { ... }
}
```

Then pass an instance to `IdempotencyModule.forRoot({ storage: new MyStorage() })`.

## IETF spec compliance

This package targets [`draft-ietf-httpapi-idempotency-key-header-07`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/). v0.1 covers:

- ✅ `Idempotency-Key` header recognition (configurable name)
- ✅ Atomic key creation (lock semantics)
- ✅ Response replay for completed requests
- ✅ 409 Conflict for in-flight duplicates
- ✅ 422 Unprocessable Entity for fingerprint mismatch
- ✅ Configurable TTL with per-endpoint override

Deferred to future versions:

- 🚧 Response header replay (v0.2)
- 🚧 PostgreSQL storage adapter (v0.2)
- 🚧 Stable JSON stringify for fingerprint (v0.2)

## Caveats (v0.1)

- **Body fingerprint uses insertion-order `JSON.stringify`** — clients should send stable JSON. Two requests with the same fields in different orders will hash differently and be treated as a fingerprint mismatch.
- **Only JSON-serializable responses are cached.** Streams, Buffers, and circular objects fall through with a warning and are not replayed.
- **Response headers are not replayed in v0.1.** The cached response carries the original status code and body only.
- **Express adapter only.** Fastify is not yet verified.

## Roadmap

- v0.2: PostgreSQL storage adapter (Prisma), response header replay, Fastify verification, dual ESM/CJS build, stable stringify
- v0.3: Custom fingerprint functions, metrics (hit rate, conflict rate), business-error caching option, Swagger/OpenAPI integration

## License

MIT — see [LICENSE](./LICENSE).
