# Changelog

All notable changes to `@nestarc/idempotency` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-03

### Added
- `PostgresStorage` — third built-in `IdempotencyStorage` adapter for Postgres.
  Atomic NX via `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now()`,
  token-based CAS on `complete()` / `delete()`, lazy expiration on `get()`.
  `pg ^8.11.0` is an optional peer dependency.
- `PostgresSweepService` — opt-in active cleanup of expired records.
  Multi-replica safe via `pg_try_advisory_lock`.
- Bundled SQL DDL at `sql/init.sql` for migration tooling, plus a
  `PostgresStorage.createSchema()` code helper and an `autoCreateSchema`
  module-init option for development.
- CI service container for Postgres 16; full unit, e2e, and v0.1.3
  regression parity is now run against PostgresStorage.
- Benchmark scenarios F (first request) and G (replay) for Postgres.

## [0.1.3] — 2026-04-09

Correctness pass addressing four findings from a cross-review. All four
are fixed with regression coverage; two related residual risks (TTL
edge values, true concurrent e2e) are also addressed. Still
pre-publication — no external breakage.

### Fixed

- **P0: `storage.complete()` failure triggered duplicate execution.**
  When the handler had already succeeded but `storage.complete()` threw
  (e.g. transient Redis outage), the interceptor's outer `catchError`
  treated the storage error like a handler error, deleted the
  PROCESSING record, and rethrew. The client's retry found no record
  and ran the handler a second time — a hard break of the at-most-once
  guarantee. `captureResponse` is now **total**: a `complete()`
  exception is caught locally, logged at ERROR level, and the handler's
  value is emitted to the client. The PROCESSING record stays in place
  and any retries correctly see 409 until TTL reclaims it. Best-effort
  error logging is also added around `delete()` cleanup paths.
- **P1: `get()` → `create()` race spuriously returned 409 when the
  winner was already COMPLETED.** The loser's `create()` returned
  `acquired: false` and the interceptor immediately threw 409 without
  re-reading the record. The correct dispatch requires knowing the
  winner's current state: replay (COMPLETED + matching fingerprint),
  422 (COMPLETED + different fingerprint), or 409 (still PROCESSING).
  `acquireAndRun` now re-reads the record on `acquired: false` and
  dispatches through `handleExistingRecord`, giving the loser the same
  state-machine paths as the initial-read branch. Falls back to 409
  only if the record has vanished between `create()` and the re-read.
- **P2: `scope: 'endpoint'` could collide across modules with the same
  class name.** Pre-0.1.3 the scope prefix was
  `ControllerClassName#methodName::`, which broke as soon as two
  controllers in separate modules shared a class name (e.g. v1/v2 APIs
  both defining a `UsersController`). The scope now reads the real
  route path from NestJS `PATH_METADATA` (stamped by `@Controller` /
  `@Post` / etc.) and builds a `HTTP_METHOD /route::` prefix. Falls
  back to the legacy `ClassName#methodName::` when path metadata is
  absent (custom decorators, non-NestJS controllers).
- **P2: README custom-storage example used the pre-token contract.**
  The `class MyStorage implements IdempotencyStorage` example showed
  `create(key, fp, ttl)` and `complete(key, response, ttl)` / `delete(key)`
  — the v0.1.0 signatures, predating the token-based CAS introduced in
  v0.1.1. Consumers who tried to follow the example would hit a
  TypeScript compile error. The README now documents the token-based
  contract, the `MutateResult` return type, and the `OnModuleDestroy`
  lifecycle recommendation.

### Added

- **TTL validation at the interceptor boundary.** `resolveOptions()`
  now rejects zero, negative, fractional, `NaN`, and `Infinity` TTL
  values with a descriptive error that names the offending value.
  Previously these would reach storage adapters where behavior diverged
  (Redis rejects `EX 0`; MemoryStorage would schedule a 0ms timer and
  evict immediately). The sync throw is converted to an Observable
  error so callers see a uniform rejection path.
- **Concurrent e2e regression test.** Two identical requests fired via
  `Promise.all` against the real NestJS app must result in **exactly
  one** handler invocation. The loser's response must either replay
  the winner (COMPLETED race) or return 409 (in-flight collision). No
  duplicate business-logic execution under any scheduling.
- **Regression test suite at `test/regression/`** covering every fix
  above (3 files, 11 new tests):
  - `complete-failure-cascade.spec.ts` — 1 test
  - `race-completed-winner.spec.ts` — 4 tests (COMPLETED replay,
    COMPLETED mismatch → 422, PROCESSING → 409, vanished → 409)
  - `path-based-scope.spec.ts` — 2 tests (cross-module isolation,
    key-prefix shape assertion)
  - `ttl-validation.spec.ts` — 11 tests (5 invalid values × 2 levels
    + 1 valid baseline)
- Public exports: `CreateResult`, `MutateResult`, `IdempotencyScope`.
  Previously documented in the type-level contract but not surfaced
  from the barrel.

### Changed (internal / non-breaking)

- `IdempotencyInterceptor.intercept()` wraps the sync `resolveOptions()`
  call in a try/catch that forwards the exception as an Observable
  error via `throwError`, so all error paths share a single
  subscription shape.
- `IdempotencyInterceptor.applyScope()` delegates to a new
  `computeEndpointScope(context)` helper and introduces a private
  static `NEST_PATH_METADATA = 'path'` constant documenting the
  hardcoded NestJS metadata key.

## [0.1.2] — 2026-04-09

SOLID-principles hardening pass. Three findings against v0.1.1 are
addressed here. All behavioral changes are backward-compatible with the
v0.1.1 public API; internals (interceptor private helpers, Redis
storage lifecycle) are restructured without changing observable
semantics for existing tests.

### Fixed

- **LSP / Storage replaceability — RedisStorage leaked its client on
  Nest shutdown.** `MemoryStorage` already implemented `OnModuleDestroy`,
  so it was automatically torn down when the host Nest app called
  `app.close()`; `RedisStorage` only exposed a bare `close()` method
  that Nest never invoked. Consumers who built `new RedisStorage({
  connection: { ... } })` (letting the storage manage its own client)
  leaked a Redis connection on every shutdown. `RedisStorage` now
  implements `OnModuleDestroy` which delegates to `close()`. If the
  consumer passed their own `client`, the hook remains a no-op —
  lifecycle stays with the owner.

- **LSP / `createdAt` contract drift.** The `IdempotencyRecord` interface
  documents `createdAt` as "when the record was first created",
  implying immutability. `RedisStorage.complete()` honored this, but
  `MemoryStorage.complete()` rewrote `createdAt = now` on every
  transition so its `lifetime = expiresAt - createdAt` matched the
  refreshed TTL. Two adapters, same interface, different observable
  behavior — a textbook LSP violation. `MemoryStorage` now preserves
  `createdAt` across `complete()`. The interface docstring is
  strengthened to make the invariant explicit.

- **SRP — interceptor `intercept()` body was monolithic.** The main
  method mixed metadata reading, header extraction, state-machine
  dispatch, lock acquisition, handler delegation, response capture,
  binary detection, and stale-token handling in a single deeply-nested
  RxJS pipeline. Three private helpers are extracted:
  - `handleExistingRecord(record, fingerprint, res)` — replay / 409 / 422
  - `acquireAndRun(scopedKey, fingerprint, opts, res, next)` — lock +
    delegate + cleanup
  - `captureResponse(scopedKey, token, value, res, ttl)` — serialization,
    guards, stale-token handling
  No class split — the refactor is file-local. Every existing test (76)
  still passes unchanged, proving the behavior is preserved.

### Added

- **Shared storage contract test suite** at
  `test/support/shared-storage-contract.ts`. Encodes 10 behavioral
  guarantees of the `IdempotencyStorage` interface (including the
  `createdAt` invariant) and runs against every adapter. Both
  `MemoryStorage` and `RedisStorage` plug into it, and any future
  adapter can opt in with `describeStorageContract('Name', factory)`.
  This is the mechanism that caught the `createdAt` drift in the first
  place and now guarantees it cannot regress.
- **Lifecycle regression tests** at
  `test/storage/redis.storage.lifecycle.spec.ts` covering the three
  ownership scenarios: internal client is closed on shutdown, consumer
  client is not, MemoryStorage is also closed.
- `IdempotencyStorage` interface docs now spell out the
  `createdAt`-immutability invariant and recommend `OnModuleDestroy`
  for adapters that own external resources.
- `ResponseShape` type alias scoped to the interceptor, documenting
  the minimal `res` API the interceptor depends on (statusCode +
  `status()`) — a small ISP improvement.

### Changed (internal / non-breaking)

- `IdempotencyInterceptor.intercept()` is now a 30-line narrative that
  delegates to three private helpers. Public signature unchanged.
- `RedisStorage` now implements `IdempotencyStorage` **and**
  `OnModuleDestroy`. The `close()` method is preserved as a public
  escape hatch for non-Nest consumers.

## [0.1.1] — 2026-04-09

First pre-publication hardening pass addressing three correctness issues
discovered against v0.1.0. Since nothing has been published to npm yet,
the storage contract changes below are breaking but have zero external
impact.

### Fixed

- **P1 — TTL expiry race could clobber a replacement record.** Previously,
  if a slow Request A's PROCESSING record was evicted by TTL and a fresh
  Request B created a new record under the same key, A's eventual
  `complete()` call would overwrite B's record. Storage contract now uses
  token-based compare-and-set: `create()` returns an opaque token, and
  `complete()` / `delete()` refuse to mutate the stored record unless the
  caller's token matches. When the interceptor observes a `stale` result
  it still emits the handler's response to the client (the handler ran,
  the client deserves its answer) but logs a warning and does not touch
  the newer record.
- **P1 — Cross-endpoint key collision.** Previously, two different
  endpoints receiving the same `Idempotency-Key` header value shared the
  same storage slot, producing either an incorrect response replay or a
  false 422. The interceptor now namespaces storage keys by
  `ControllerName#methodName::` by default, matching the IETF draft
  recommendation that idempotency is scoped per (key, request URI). A
  new `scope` module option offers `'endpoint'` (default), `'global'`
  (legacy behavior), or a custom `(ctx) => string` function for
  multi-tenant setups.
- **P2 — Buffer and stream responses silently cached as JSON garbage.**
  The README promised that only JSON-serializable responses are cached,
  but the code used `JSON.stringify` with only a circular-ref guard —
  `JSON.stringify(buffer)` succeeds and produces
  `{"type":"Buffer","data":[...]}`, which round-trips to a broken object
  on replay. The interceptor now actively detects `Buffer`,
  `ArrayBuffer.isView`, `ArrayBuffer`, Node `Readable`-like (`pipe()`),
  and Web `ReadableStream`-like (`getReader()`) values and bypasses
  caching with a logged warning. The handler still runs and the caller
  still gets the original response — only the cache write is skipped.

### Changed (breaking — pre-publication)

- `IdempotencyStorage` contract:
  - `create(key, fingerprint, ttlSeconds)` now returns
    `{ acquired: boolean; token?: string }` instead of `boolean`.
  - `complete(key, token, response, ttlSeconds)` now requires the token
    and returns `'ok' | 'stale'`.
  - `delete(key, token)` now requires the token and returns
    `'ok' | 'stale'`.
- `IdempotencyRecord` now carries a mandatory `token: string` field.
- `RedisStorage` now stores each record as a Redis Hash (`token` +
  `payload` fields) instead of a single JSON string, and uses three
  Lua scripts (`idemCreate`, `idemComplete`, `idemDelete`) registered
  via `defineCommand` to run compare-and-set atomically on the server.
- `IdempotencyOptions` gains an optional `scope` field.

### Added

- `IdempotencyScope` type and `scope` option on `IdempotencyOptions`.
- Regression tests covering:
  - TTL-expiry race with `stale` result propagation.
  - Cross-endpoint collision (two controllers using the same key value).
  - `scope='global'` / `scope='endpoint'` / `scope=function` variants.
  - Buffer, `Uint8Array`, `ArrayBuffer`, Node stream, and Web
    `ReadableStream` bypass behavior.
- E2E regression: two distinct controllers sharing the same
  `Idempotency-Key` header value, verifying both handlers run exactly
  once and each replays within its own scope.

## [0.1.0] — 2026-04-09

Initial pre-publication cut — never shipped to npm. See §Fixed above
for the correctness issues found and addressed in 0.1.1.

### Added

- `IdempotencyModule.forRoot()` / `forRootAsync()` dynamic module.
- `@Idempotent()` method decorator with per-handler overrides.
- `IdempotencyInterceptor` implementing the IETF draft
  `httpapi-idempotency-key-header-07` state machine (400 / 409 / 422).
- `MemoryStorage` and `RedisStorage` adapters implementing a common
  `IdempotencyStorage` interface.
- SHA-256 request body fingerprint with per-handler / module override.
- Response replay (status code + body, headers deferred to v0.2).
- 58-test TDD suite: decorator, storages, interceptor state machine
  matrix (19 cases), module wiring, and Express-adapter e2e.
