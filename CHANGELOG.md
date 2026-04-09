# Changelog

All notable changes to `@nestarc/idempotency` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
