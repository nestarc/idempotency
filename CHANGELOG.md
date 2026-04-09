# Changelog

All notable changes to `@nestarc/idempotency` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
