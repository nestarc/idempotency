# Idempotency benchmark

This source-checkout benchmark measures sequential HTTP round-trip latency for
Express and Fastify, with Memory, Redis and PostgreSQL storage. It checks
correctness before accepting any timing sample. It is a diagnostic tool, not a
throughput test, an isolated measurement of interceptor overhead, or a replacement
for the actual-tarball consumer tests and release validation matrix.

## Run

Use the package's supported Node.js 22 or 24 and install from the lockfile:

```sh
npm ci
npm run bench -- --help
npm run bench -- --adapter both --iterations 200 --warmup 20
```

Without service URLs, Memory runs and the report explicitly records Redis and
PostgreSQL as skipped (`pass-with-skips`). Both service URLs have environment
fallbacks; command-line `--redis-url` and `--postgres-url` override them.
A configured service that cannot load, connect or initialize fails the run.

Use test-only services. The repository's Compose configuration provides PostgreSQL
16 and Redis 7; its database name and credentials are shown in `docker-compose.yml`.
PostgreSQL credentials must permit creating and dropping a schema in that database.

```sh
docker compose up -d --wait
export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test
export TEST_REDIS_URL=redis://localhost:6379
npm run bench:smoke
npm run bench -- --adapter both --require-services \
  --iterations 2000 --warmup 100 --request-timeout-ms 5000 \
  --output /tmp/idempotency-benchmark.json
```

`bench:smoke` runs all six adapter/storage combinations with five samples and one
warmup per scenario. It requires both services and checks functionality only.
Use `--output` with a fresh file in an existing directory. The runner refuses to
overwrite previous evidence, including when a run fails. Reports omit service
URLs and credentials.

## What is measured and checked

Each adapter/storage combination starts a fresh Nest application on an ephemeral
`127.0.0.1` port and uses an explicit keep-alive agent with one connection. Even
with `--warmup 0`, an untimed baseline request establishes the connection and
untimed idempotency probes validate first request, replay, payload mismatch and
replay after mismatch. Then three scenarios run in this fixed order:

1. **Baseline:** POST without the interceptor; one handler execution per request.
2. **First request:** a unique key for every warmup and measured request; one
   handler execution and `Idempotency-Status: created`.
3. **Replay:** reuse a separately seeded key; the stored payload and status must
   match, replay headers must be present, and the handler must not run again.

Every response is checked for the expected HTTP status, exact JSON payload,
idempotency headers and handler execution count, including all warmups and probes.
Thus an HTTP 500, failed completion that still returns HTTP 201, or duplicate
handler execution invalidates the run. Assertion work occurs after the timed HTTP
response has completed. The response helper enforces an overall deadline (even
for a continuously trickling response), complete HTTP framing and a 1 MiB cap.

The JSON report includes raw millisecond samples, sample counts, average/min/max,
nearest-rank p50/p95/p99, warmup counts, handler counts, service versions,
Node/Nest/driver versions, CPU/OS, commit and dirty-checkout state, configuration,
skips, failures and cleanup outcomes. Any failure discards all performance samples
from the report and exits nonzero; setup failures leave later cells `not-run`.

These timings include the client, TCP, adapter, serialization and storage round
trips in the same process. Baseline differences are context, not isolated package
overhead. No requests are concurrent, and no requests-per-second claim is made.
GC, growing first-request storage, scenario order, connection warmth, machine
load and remote service placement affect results. A p99 from a short smoke run
is not meaningful performance evidence. Compare repeated, longer runs on the same
machine, runtime, dependencies and service topology; retain their reports.

## Isolation and lifecycle

Each cell gets a cryptographic UUID. Redis uses an owned `bench_idem_<uuid>:`
prefix; PostgreSQL atomically creates an owned `bench_idem_<uuid>` schema and
restricts every pooled connection's search path to it. Existing default tables
are never truncated. Namespace collisions fail without claiming or deleting the
existing namespace. Connections use bounded timeouts and Redis does not reconnect
or queue commands indefinitely. Redis URL options cannot override these controls;
PostgreSQL startup options are replaced to enforce the isolated search path.

After success or failure, the runner destroys its HTTP agent, closes the Nest
application, removes only its own Redis keys/PostgreSQL schema, and closes its
externally supplied driver connections. Storage cleanup still runs if app shutdown
fails; cleanup failure makes the run fail. A first SIGINT/SIGTERM requests graceful
cleanup after the current bounded operation. SIGKILL, a second interrupt, or an
unreachable service can prevent cleanup. Redis records have a 24-hour TTL;
PostgreSQL schemas can remain and are identified by namespace UUID in the report.

## Maintenance

`npm run lint` and the root TypeScript project include all benchmark TypeScript.
Regression tests cover CLI/statistics, transport deadlines, response validation,
runner failure handling and namespace ownership. They are part of `test:all`:

```sh
npm run lint
npx tsc --noEmit --incremental false
npm run test -- --runInBand test/regression/benchmark
npm run build
```

The published build still includes only `src`; benchmark helpers, test code and
reports are not part of the package. No benchmark latency threshold gates a release.

## Verification recorded on 2026-10-07

- Full Jest run with both real service URLs: **45 suites, 1,044 tests passed,
  zero skips/todos**, including 107 benchmark regression tests.
- Node.js **22.23.3 and 24.11.1**, Nest **11.1.18** (Fastify adapter **11.1.19**),
  PostgreSQL **16.14**, Redis **7.2.7**, pg **8.20.0**, ioredis **5.10.1**:
  Express/Fastify × Memory/Redis/Postgres smoke runs passed. Each run measured
  five requests per scenario after one warmup; these are functional checks.
- Real-service isolation check: an existing public records-table row and an
  unrelated Redis key survived unchanged; every reported benchmark schema/prefix
  was removed. SIGTERM during Redis work also preserved them, cleaned the owned
  namespace and produced a failed report with no timing samples.
- Unreachable configured Redis, missing required services, zero iterations and
  an existing output path all exited nonzero. Failure reports omitted URLs and
  credentials; existing output content was preserved.
- ESLint, strict TypeScript, formatting, build and package dry-run passed.
  The package manifest contained no benchmark or test files.

These local results use the current source checkout and the listed dependency
versions. They do not constitute a new release matrix or Nest 10 benchmark run.
