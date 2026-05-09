# v0.3.0 Reliability Design

**Date:** 2026-05-10
**Package:** `@nestarc/idempotency`
**Target version:** `0.3.0`
**Status:** Draft for user review

## Goal

Make `@nestarc/idempotency` more reliable for production NestJS services by
closing known correctness gaps, broadening adapter/runtime verification, and
hardening the release path.

The release should feel like a practical trust upgrade rather than a large new
surface area release. It improves behavior that users naturally expect from an
idempotency package: endpoint isolation should match the actual request target,
equivalent JSON payloads should fingerprint consistently, cached responses
should replay meaningful headers, and the package should be verified under the
main NestJS HTTP adapters and storage backends it claims to support.

## Recommended Scope

Ship these five items together:

1. Actual request target based endpoint scoping.
2. Stable JSON fingerprinting.
3. Response header capture and replay.
4. Fastify adapter verification.
5. CI and release hardening for Postgres and Redis.

These items reinforce each other. The first three improve request/response
correctness, while the last two make those guarantees more believable before
publish.

## Non-Goals

`@TransactionalIdempotent` is intentionally out of scope for v0.3.0. It is a
larger design involving business transactions, storage adapter boundaries, and
consumer application code. It should be designed separately for v0.4.0 or as an
experimental feature.

The release will not add metrics hooks, Swagger/OpenAPI decorators, tenant
integration, JSONB response storage, or dual ESM/CJS output unless they fall out
as trivial documentation-only updates. Those are better as future minor
versions.

## Architecture

The existing public model remains intact:

- `IdempotencyModule` registers module options and storage.
- `@Idempotent()` enables interception per handler.
- `IdempotencyInterceptor` owns request classification, storage state-machine
  dispatch, response capture, and replay.
- `IdempotencyStorage` remains the adapter contract for atomic creation and
  token-based mutation.

v0.3.0 should add small, explicit helper boundaries inside the interceptor
rather than expanding one method further:

- A scope resolver that computes the storage namespace from the request.
- A fingerprint serializer that produces deterministic JSON for supported
  payloads.
- A response replay policy that captures and restores status, body, and allowed
  headers.

These helpers can start as private functions/classes if no public API is needed.
They should be tested directly through interceptor behavior and e2e scenarios.

## Feature 1: Actual Request Target Based Endpoint Scope

### Problem

The current `scope: 'endpoint'` behavior uses Nest route metadata to build keys
like `POST /orders/:id/capture::raw-key`. That isolates route templates, but it
can still conflate distinct resources handled by the same route pattern.

Example risk:

- `POST /orders/1/capture` with key `abc` and body `{ "amount": 10 }`
- `POST /orders/2/capture` with key `abc` and body `{ "amount": 10 }`

Both can map to the same route-template scope even though they target different
resources.

### Design

For `scope: 'endpoint'`, compute the scope from the actual HTTP method plus the
actual request path available on the platform request object.

Preferred path source order:

1. Express: `req.originalUrl` without query string.
2. Fastify: `req.url` without query string.
3. Fallback: current Nest metadata route-template behavior.
4. Final fallback: `ControllerClassName#methodName`.

Query strings should not be included by default. The IETF draft frames the
server responsibility around request target/URI, but including arbitrary query
ordering would create accidental mismatches. If query-sensitive idempotency is
needed, users can provide a custom `scope` function.

### Compatibility

This changes default key derivation for parameterized routes. It is a safer
default, but it may cause existing cached records under old template-based keys
to stop replaying after upgrade. That is acceptable for a minor version because
records are TTL-bound and the change fixes a correctness issue.

Document the behavior change in README and CHANGELOG.

## Feature 2: Stable JSON Fingerprint

### Problem

Fingerprinting currently uses insertion-order `JSON.stringify`. Semantically
equivalent JSON objects with different key order can produce different hashes.

### Design

Add a deterministic serializer for JSON-compatible request bodies:

- Sort object keys lexicographically at every object level.
- Preserve array order.
- Preserve primitive values exactly as JSON would.
- Treat `undefined` consistently with JSON serialization rules.
- Follow `JSON.stringify` failure behavior for unsupported values such as
  `BigInt` or circular references. v0.3.0 should not expand supported request
  body types beyond normal HTTP JSON bodies.

The interceptor should continue hashing the serialized representation with
SHA-256.

### Compatibility

This can change fingerprints for some existing records. Like endpoint scoping,
the effect is bounded by TTL and fixes a documented caveat. Document the change.

## Feature 3: Response Header Capture and Replay

### Problem

The package currently replays status code and body only. Real HTTP responses
often rely on headers such as `Location`, `Content-Type`, `ETag`, and custom
business headers.

### Design

Extend `IdempotencyRecord` and `CompleteResponse` to optionally store response
headers.

Capture a conservative allowlist by default:

- `content-type`
- `location`
- `etag`
- `cache-control`
- custom application headers that start with `x-`

Never cache hop-by-hop or unsafe headers:

- `set-cookie`
- `connection`
- `transfer-encoding`
- `keep-alive`
- `upgrade`
- `proxy-authenticate`
- `proxy-authorization`
- `te`
- `trailer`

The interceptor should normalize stored header names to lowercase and replay
them through the platform response object when available.

Add an optional module-level `replayHeaders` option with:

- `true`: use the default allowlist.
- `false`: disable header capture.
- `string[]`: explicit allowlist, still filtered through the unsafe denylist.

Default should be `true` for the conservative allowlist.

### Storage Impact

All adapters need to persist `responseHeaders?: Record<string, string>`.

- Memory: store directly in the record.
- Redis: include in the serialized payload.
- Postgres: add a nullable `response_headers JSONB` column. The project already
  targets Postgres 12+ for bundled schema compatibility.

Provide a migration note for existing Postgres users:

```sql
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS response_headers JSONB;
```

The bundled `sql/init.sql` and `PostgresStorage.createSchema()` should include
the new column for fresh installs.

## Feature 4: Fastify Adapter Verification

### Problem

The current README caveats say Express is verified and Fastify is not. NestJS
users commonly choose either adapter, so the library should prove that its
request and response abstractions work under both.

### Design

Add Fastify e2e coverage that mirrors the Express e2e contract:

- first request runs handler and stores response;
- duplicate request replays response;
- missing key returns 400 when required;
- mismatch returns 422;
- concurrent duplicate gets one execution and one conflict/replay;
- header replay works under Fastify.

If implementation differences are needed, hide them behind small request/response
helper functions rather than branching throughout the interceptor.

## Feature 5: CI and Release Hardening

### Problem

CI validates Postgres with a service container, but the release workflow can run
`prepublishOnly` without `TEST_DATABASE_URL`, causing Postgres suites to skip.
Redis production behavior also depends on Lua commands but is currently covered
only through `ioredis-mock`.

### Design

Update release workflow to mirror CI's Postgres service and set
`TEST_DATABASE_URL` for the prepublish chain.

Add a dedicated real Redis smoke job. It should run a focused adapter contract
against a Redis service, not the full suite, to keep CI time controlled while
covering the Lua commands used in production.

Keep local developer ergonomics unchanged: Postgres and real Redis tests may
skip when their environment variables are absent, but CI and release should
provide those services.

## Testing Strategy

Unit and regression tests:

- Add route-param endpoint-scope regression tests for Express fixtures.
- Add query-string behavior tests proving query is ignored by default.
- Add stable fingerprint tests for nested object key order.
- Add header allowlist and denylist tests.
- Extend shared storage contract to include optional response headers.

E2E tests:

- Add Express e2e cases for path params and header replay.
- Add Fastify e2e suite with the same high-value scenarios.
- Add Postgres migration/schema tests for `response_headers`.

CI tests:

- Keep Node 20/22 and NestJS 10/11 matrix.
- Ensure Postgres-backed tests run in CI and release.
- Add one real Redis smoke job for Lua command coverage.

## Documentation

Update README:

- Remove stable-stringify and Fastify from deferred caveats once implemented.
- Document actual-path endpoint scoping and the query exclusion rule.
- Document response header replay, including the default allowlist and denylist.
- Add Postgres migration note for `response_headers`.

Update CHANGELOG:

- Call out the endpoint-scope key derivation change.
- Call out stable fingerprint behavior change.
- Call out Postgres schema migration for response headers.

Repair visibly broken mojibake in touched docs while preserving meaning.

## Rollout Risks

Endpoint scoping and stable fingerprints can change cache keys/fingerprints for
in-flight TTL records. The impact is temporary and correctness-improving, but it
must be documented.

Header replay can accidentally leak or replay unsafe headers if the policy is
too broad. Use a conservative allowlist plus a hard denylist.

Fastify support may reveal platform response API differences. Keep response
touchpoints behind helper functions to avoid spreading adapter-specific logic.

Postgres schema changes require user action for existing deployments. Make the
migration SQL explicit and idempotent.

## Acceptance Criteria

v0.3.0 is ready when:

- Parameterized routes no longer collide under `scope: 'endpoint'`.
- Query strings are intentionally excluded from default endpoint scope and this
  is documented.
- Stable JSON fingerprinting treats object key-order differences as equivalent.
- Replayed responses restore status, JSON body, and allowed headers.
- Unsafe headers are never stored or replayed by default.
- Memory, Redis, and Postgres adapters satisfy the updated storage contract.
- Express and Fastify e2e suites pass.
- CI and release both run Postgres-backed tests.
- CI includes real Redis smoke coverage.
- README and CHANGELOG describe all behavior and migration changes.

## Suggested Implementation Order

1. Add regression tests for endpoint scoping and stable fingerprinting.
2. Implement scope resolver and deterministic serializer.
3. Extend storage contract and adapters for response headers.
4. Add header replay behavior and tests.
5. Add Fastify e2e coverage.
6. Harden CI/release for Postgres and Redis.
7. Update README and CHANGELOG.

This order catches correctness bugs before broadening infrastructure work and
keeps the release shippable after each major slice.
