# Test scope and reliability audit

The tests check observable behavior: response bytes and headers, handler execution,
stored ownership and expiry, and independent business side effects. A passing mock
call or a high test count alone is not evidence that idempotency works.

## Test layers

| Layer                             | What it establishes                                                                                                | Boundary                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Interceptor, module and decorator | Validation, acquisition token, completion acknowledgement, real Nest DI, metadata isolation                        | Programmable doubles inject specific failures; they are not storage implementations under validation.                      |
| Shared storage contract           | NX ownership, stale-token rejection, immutable winner, complete-once, TTL and deletion                             | Runs against real Memory, real PostgreSQL and real Redis; ioredis-mock is an additional unit layer.                        |
| HTTP E2E and response regressions | Actual Express/Fastify requests, exact payload/status/header replay, in-flight conflict, handler effects           | Local HTTP is not a production load test. Explicit gates establish overlap.                                                |
| Failure lifecycle and migration   | Actual SIGKILL boundaries, durable PostgreSQL business ledger, retries, retained leases and command reconciliation | Injected completion rejections do not simulate network partitions. Business commit and replay persistence remain separate. |
| Installed consumers               | Public imports/types and real HTTP/storage against the packed npm artifact                                         | Expected missing-pg-types failures specifically require TS7016; they are not arbitrary failed builds.                      |
| Release gates                     | Reject missing, skipped, duplicated, reduced or altered evidence; tie it to the artifact                           | Synthetic reports test the verifier. They do not themselves claim that a release matrix ran.                               |
| Benchmark regressions             | Correctness before timing, deadlines, cleanup, real namespace isolation and preservation of unrelated data         | A mock connection tests orchestration; real-service tests separately prove SQL/Redis behavior.                             |
| Selected mutation probes          | Existing tests reject deliberately injected core defects                                                           | Seven selected changes do not constitute exhaustive mutation coverage.                                                     |

The independent fixture in `support/request-key.ts` fixes the persisted v1 key
shape without importing its production encoder. Replay-format tests likewise use
literal persisted values so an encoder and decoder drifting together cannot hide
a protocol change. `support/fake-storage.ts` remains a programmable interceptor
test seam; actual adapter contracts use the production adapters.

## Run complete checks

Use test-only PostgreSQL 16 and Redis 7 services. The suite creates and drops
run-specific tables, schemas and key prefixes. Real sweep fixtures share a separate
test advisory lock so parallel Jest workers can exercise the production sweep lock
without interfering with each other.

```sh
docker compose up -d --wait
export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test
export TEST_REDIS_URL=redis://localhost:6379
npm run lint
npx tsc --noEmit --incremental false
S5_REQUIRE_REAL_STORAGE=1 npm run test:all -- --runInBand --coverage \
  --json --outputFile=/tmp/idempotency-tests.json
npm run test:release-gates
npm run test:consumers -- --output /tmp/idempotency-consumers
npm run test:mutations -- --output /tmp/idempotency-mutations
npm run build
```

Choose fresh output paths. Default Jest commands can explicitly skip real-service
suites when their URLs are absent. Such a partial local run is not full validation.
`S5_REQUIRE_REAL_STORAGE=1` makes missing service URLs fail, while the release
verifier additionally rejects every skip/todo and missing required spec. To inspect
the full Jest JSON with that verifier:

```sh
node --input-type=module -e \
  "import {readJson,verifyJest} from './scripts/release-gates.mjs'; console.log(verifyJest(readJson('/tmp/idempotency-tests.json')))"
```

`test/release/release-gates.test.mjs` independently discovers the actual Jest spec
files and compares them to `REQUIRED_SPECS`. Adding a suite without updating the
release inventory now fails. Counts protect against accidental deletion; the
assertions and mutation checks establish behavioral value. Do not add empty or
duplicated cases to satisfy a count.

## Audit changes, 2026-10-07

All **77 pre-existing files** under `test` were reviewed, including support code,
consumer manifests/TypeScript configs, documentation and the Node release tests.
The inventory below distinguishes changed files from intentionally retained ones.
Pinned minimum peer versions, public type-negative cases and README quickstart
fixtures were retained as supported contracts rather than upgraded automatically.

| Weakness found                                                      | Replacement evidence                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| TTL override test only retried immediately                          | HTTP request at 299,999 ms still replays; at 300,000 ms executes again; default TTL control still replays.            |
| A concurrency test could finish as sequential replay                | Hold the first handler, require conflict and no second effect, release it, then verify replay.                        |
| Calling `complete()` mistaken for awaiting completion               | Hold completion acknowledgement and prove no result is emitted until it resolves.                                     |
| A “Promise handler” used a synchronous Observable                   | Use a controlled asynchronous handler and assert its live processing conflict.                                        |
| Scope-collision fixture used different class names                  | Use genuinely identical runtime names and verify both paths retain independent results.                               |
| Expected keys and stored replay payloads reused production encoders | Independent v1 fixtures and literal protocol values.                                                                  |
| Stale-owner assertions allowed any token or checked partial state   | Exact acquired tokens, different valid UUIDs, and full record/TTL preservation.                                       |
| Redis race did not force a stale read before CAS                    | Two real clients plus a transport gate; the loser cannot overwrite the completed/replaced winner.                     |
| Pool shutdown only checked a mock call/private field                | Open a real connection, close Nest, require owned-pool queries to fail and external-pool queries to succeed.          |
| Fixed PostgreSQL table names crossed run boundaries                 | UUID tables and failure-safe cleanup; benchmark tests also preserve pre-existing records during namespace collisions. |
| Sweep tests checked an internal timer                               | Observe actual deleted/retained rows, post-shutdown inactivity and advisory-lock release after SQL failure.           |
| Tarball storage checks omitted real interceptor HTTP                | Installed Memory/Redis/Postgres run conflict, mismatch, concurrent replay and handler-effect checks.                  |
| Release test inventory still described only S7                      | Discover all current specs independently and require the reviewed 46-suite baseline.                                  |

Minimum-version verification also caught three TypeScript incompatibilities:
`PoolConfig.lock_timeout` and two `Pool.ending` accesses were absent from the
supported `@types/pg` 8.11 declarations. The benchmark now sets the lock deadline
through PostgreSQL startup options, checked against the actual server. Lifecycle
tests use public shutdown behavior and no longer read `Pool.ending`.

## Recorded validation

- **Node 24.11.1 / Nest 11.1.18** (Fastify adapter 11.1.19), ioredis 5.10.1,
  pg/@types/pg 8.20.0: **46 suites / 1,093 tests passed, zero skips**,
  strict TypeScript, lint and build passed. Source branch coverage was **95.05%**
  and line coverage **98.60%**; these are execution metrics, not defect guarantees.
- **Node 22.23.3 / Nest 10.4.22**, ioredis 5.0.0, pg/@types/pg 8.11.0:
  **46 suites / 1,093 tests passed, zero skips**, strict TypeScript passed.
- Both runs use actual PostgreSQL 16.14 and Redis 7.2.7, including all ten real
  failure-lifecycle scenarios. The minimum-version install runs in an isolated
  copy; the original dependency tree and lockfile remain unchanged.
- Installed tarball consumers on Node 24: Nest 11/representative and
  Nest 10/minimum each passed **47 checks plus three expected TS7016 failures**,
  zero skips. After strengthening valid-UUID stale ownership, all six installed
  Memory/Redis/Postgres runtimes were rechecked with the final fixture hash recorded.
- **78 release-gate tests passed**, including the independent spec inventory.
- Source mutation baseline: **307 tests passed** before injection. All **seven
  selected defects were killed by matcher assertions**, zero survivors/errors;
  original source hashes were unchanged. See [mutation probes](mutation/README.md).
- Two further installed-tarball mutations (NX acquisition and completion owner
  checks removed) both failed the consumer assertions; restoring the package passed.

Local evidence is retained under `/private/tmp/idempotency-test-audit`: final
Jest/coverage/S5 reports, both installed-consumer summaries and follow-up fixture
hashes, minimum-version `attempt-1`/`attempt-2` logs, and `mutations/summary.json`
with exact patches and failed assertion names. The initial minimum-type failures
are retained separately from the successful rerun.

This audit exercised two complementary source environments and two consumer
profiles, not a new eight-cell release-validation run. The selected mutations,
branch coverage and test counts cannot establish that every defect or every race
is detected. The immutable-artifact release matrix remains required for publication.

## Reviewed file inventory

The entries below refer to the files present before the audit. “Retained” means
the existing behavior, types, fixture role or documented boundary was reviewed and
kept. New supporting files are listed separately.

| File                                             | Audit disposition                                             |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `consumers/README.md`                            | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/common/baseline.cjs`                  | Removed: unused duplicate consumer baseline                   |
| `consumers/common/baseline.ts`                   | Retained: reviewed existing contract                          |
| `consumers/common/module-examples.ts`            | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/common/public-api.ts`                 | Retained: reviewed existing contract                          |
| `consumers/common/runtime.cjs`                   | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/common/tsconfig.json`                 | Retained: reviewed existing contract                          |
| `consumers/memory/consumer.ts`                   | Retained: reviewed existing contract                          |
| `consumers/memory/examples.ts`                   | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/memory/http-adapters.ts`              | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/memory/package.json`                  | Retained: reviewed existing contract                          |
| `consumers/memory/quickstart.ts`                 | Retained: reviewed existing contract                          |
| `consumers/memory/runtime.cjs`                   | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/memory/tsconfig.json`                 | Retained: reviewed existing contract                          |
| `consumers/postgres/consumer.ts`                 | Retained: reviewed existing contract                          |
| `consumers/postgres/examples.ts`                 | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/postgres/package.json`                | Retained: reviewed existing contract                          |
| `consumers/postgres/runtime.cjs`                 | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/postgres/tsconfig.json`               | Retained: reviewed existing contract                          |
| `consumers/redis/consumer.ts`                    | Retained: reviewed existing contract                          |
| `consumers/redis/examples.ts`                    | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/redis/package.json`                   | Retained: reviewed existing contract                          |
| `consumers/redis/runtime.cjs`                    | Updated: behavioral assertion, fixture or validation boundary |
| `consumers/redis/tsconfig.json`                  | Retained: reviewed existing contract                          |
| `e2e/adoption-recipes.e2e-spec.ts`               | Updated: behavioral assertion, fixture or validation boundary |
| `e2e/fastify.e2e-spec.ts`                        | Updated: behavioral assertion, fixture or validation boundary |
| `e2e/idempotency.e2e-spec.ts`                    | Updated: behavioral assertion, fixture or validation boundary |
| `e2e/postgres.e2e-spec.ts`                       | Updated: behavioral assertion, fixture or validation boundary |
| `e2e/request-isolation.e2e-spec.ts`              | Updated: behavioral assertion, fixture or validation boundary |
| `idempotency.decorator.spec.ts`                  | Updated: behavioral assertion, fixture or validation boundary |
| `idempotency.interceptor.spec.ts`                | Updated: behavioral assertion, fixture or validation boundary |
| `idempotency.module.spec.ts`                     | Updated: behavioral assertion, fixture or validation boundary |
| `regression/adoption-migration.spec.ts`          | Updated: behavioral assertion, fixture or validation boundary |
| `regression/benchmark-helpers.spec.ts`           | Retained: reviewed existing contract                          |
| `regression/benchmark-response.spec.ts`          | Retained: reviewed existing contract                          |
| `regression/benchmark-runner.spec.ts`            | Retained: reviewed existing contract                          |
| `regression/benchmark-storage.spec.ts`           | Updated: behavioral assertion, fixture or validation boundary |
| `regression/complete-failure-cascade.spec.ts`    | Updated: behavioral assertion, fixture or validation boundary |
| `regression/failure-lifecycle.real.spec.ts`      | Updated: behavioral assertion, fixture or validation boundary |
| `regression/failure-lifecycle.spec.ts`           | Retained: reviewed existing contract                          |
| `regression/memory-long-ttl.spec.ts`             | Retained: reviewed existing contract                          |
| `regression/observability-headers-sweep.spec.ts` | Retained: reviewed existing contract                          |
| `regression/observability-safety.spec.ts`        | Retained: reviewed existing contract                          |
| `regression/optional-peer-boundary.spec.ts`      | Updated: behavioral assertion, fixture or validation boundary |
| `regression/path-based-scope.spec.ts`            | Updated: behavioral assertion, fixture or validation boundary |
| `regression/postgres-adapter.spec.ts`            | Updated: behavioral assertion, fixture or validation boundary |
| `regression/postgres-sweep-wiring.spec.ts`       | Updated: behavioral assertion, fixture or validation boundary |
| `regression/race-completed-winner.spec.ts`       | Updated: behavioral assertion, fixture or validation boundary |
| `regression/replay-body-format.spec.ts`          | Updated: behavioral assertion, fixture or validation boundary |
| `regression/request-isolation.spec.ts`           | Retained: reviewed existing contract                          |
| `regression/request-key-validation.spec.ts`      | Updated: behavioral assertion, fixture or validation boundary |
| `regression/response-capture-failure.spec.ts`    | Retained: reviewed existing contract                          |
| `regression/response-completion.spec.ts`         | Updated: behavioral assertion, fixture or validation boundary |
| `regression/response-replay-boundary.spec.ts`    | Updated: behavioral assertion, fixture or validation boundary |
| `regression/response-replay-http.spec.ts`        | Updated: behavioral assertion, fixture or validation boundary |
| `regression/storage-lifecycle-contract.spec.ts`  | Updated: behavioral assertion, fixture or validation boundary |
| `regression/storage-ttl-validation.spec.ts`      | Retained: reviewed existing contract                          |
| `regression/ttl-validation.spec.ts`              | Updated: behavioral assertion, fixture or validation boundary |
| `release/release-gates.test.mjs`                 | Updated: behavioral assertion, fixture or validation boundary |
| `services/postgres-sweep.service.spec.ts`        | Updated: behavioral assertion, fixture or validation boundary |
| `storage/memory.storage.spec.ts`                 | Updated: behavioral assertion, fixture or validation boundary |
| `storage/postgres.storage.lifecycle.spec.ts`     | Updated: behavioral assertion, fixture or validation boundary |
| `storage/postgres.storage.spec.ts`               | Updated: behavioral assertion, fixture or validation boundary |
| `storage/redis.storage.lifecycle.spec.ts`        | Updated: behavioral assertion, fixture or validation boundary |
| `storage/redis.storage.real.spec.ts`             | Updated: behavioral assertion, fixture or validation boundary |
| `storage/redis.storage.spec.ts`                  | Updated: behavioral assertion, fixture or validation boundary |
| `support/adoption-business.ts`                   | Retained: reviewed existing contract                          |
| `support/execution-context.factory.ts`           | Updated: behavioral assertion, fixture or validation boundary |
| `support/failure-lifecycle-child.ts`             | Updated: behavioral assertion, fixture or validation boundary |
| `support/failure-lifecycle-real.ts`              | Updated: behavioral assertion, fixture or validation boundary |
| `support/fake-storage.ts`                        | Updated: behavioral assertion, fixture or validation boundary |
| `support/request-key.ts`                         | Updated: behavioral assertion, fixture or validation boundary |
| `support/shared-storage-contract.ts`             | Updated: behavioral assertion, fixture or validation boundary |
| `utils/request-key.spec.ts`                      | Updated: behavioral assertion, fixture or validation boundary |
| `utils/request-scope.spec.ts`                    | Retained: reviewed existing contract                          |
| `utils/response-headers.spec.ts`                 | Updated: behavioral assertion, fixture or validation boundary |
| `utils/stable-json.spec.ts`                      | Updated: behavioral assertion, fixture or validation boundary |

New files: `regression/benchmark-storage.real.spec.ts`,
`consumers/common/http-contract.ts`, `mutation/run.mjs`, `mutation/README.md`,
and this audit guide.
