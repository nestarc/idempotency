# Migrating from 0.4 to the 1.0 contract

This guide describes the unreleased 1.0 contract and [D07](1.0.0/decisions.md#d07--10-전환과-롤백-decided).
It does not announce a published 1.0 package. Use the release artifact validated
for your deployment; the final version matrix and publishing gate belong to S8.

The upgrade requires **both a separate, empty storage namespace and durable
business deduplication covering attempts handled by either version**. Stop
traffic, drain and reconcile work, then replace all writers before resuming.
A rolling deployment in which old and new writers can process the same business
command is unsupported, even if they use different cache namespaces.

## Changes to audit before deployment

| Contract | Change from 0.4 | Required application action |
| --- | --- | --- |
| Storage addresses | Every scope now uses a versioned SHA-256 address encoding a JSON tuple. No legacy alias lookup, move or delete. | Choose a separate empty namespace; preserve old records for controlled investigation. Prevent business execution from repeating on the resulting cache misses. |
| Scope | Function results add identity to method + actual path; they no longer replace the endpoint. Arrays preserve tenant/user boundaries. Actual duplicate/trailing slashes and percent encoding remain distinct; query remains excluded. | Use identity verified by a guard on every request, including replay. Audit any workflow that intentionally shared a key across endpoints. Endpoint alone does not infer a user; global deliberately shares all callers and endpoints. |
| Default fingerprint | No algorithm change: SHA-256 of recursively stable JSON, using `body ?? null`. Arrays remain ordered. | Keep business semantics stable. No stored fingerprint rewrite is provided or needed. A changed key address still misses the old record even when its fingerprint matches. |
| Custom fingerprint | The API remains `{ context, key, scope, body, defaultFingerprint }`; `key` is the raw key, while `scope` is now the encoded storage address. | Audit resolvers that concatenate or interpret `scope`; their results can change. It is not the new observation `namespace`. Keep a business parameter check in the durable command ledger. |
| Response body | New opaque `@nestarc/idempotency:replay:v1:` string stores the final supported plain JSON response. Old JSON readers cannot decode it. New readers reject legacy/corrupt COMPLETED bodies with 409; fingerprint mismatch has priority with 422. | Put idempotency outside response serializers. Do not rewrite legacy bodies into the envelope: the old record cannot prove safe serialization or authenticated ownership. Custom adapters preserve the string verbatim. |
| SQL schema | No new 1.0 columns, state or schema migration. `response_body` remains TEXT; headers remain JSONB. | Provision a separate table with the existing schema. The historical 0.2 → 0.3 `response_headers` column addition is described below and is not a 1.0 migration. |
| Imports and peers | Root exposes memory/common APIs. Redis and Postgres exports move to `/redis` and `/postgres`. | Change imports and install the chosen optional driver. PG TypeScript consumers also install `@types/pg`; tested TypeScript minimum is 5.7.3. Avoid internal `dist/*` paths. |
| Sweep DI | Nest injects `IDEMPOTENCY_STORAGE` into `PostgresSweepService`, using the same adapter as the module. | Official module wiring now works. A manual provider graph that only registered `PostgresStorage` by class must also provide `IDEMPOTENCY_STORAGE` (for example `useExisting: PostgresStorage`). Direct `new PostgresSweepService(storage, options)` is unchanged. |
| Key input and options | Header is one raw opaque string; quotes are literal. Repeated, array, comma-joined, empty/blank, control and unpaired-surrogate values are 400. Resolver replaces the header and may contain commas. `maxKeyLength` measures UTF-8 bytes, default 255. | Correct invalid producers and non-ASCII length assumptions. Only `undefined` is missing; `required: false` does not accept invalid keys. Invalid `maxKeyLength` or scope configuration is a server configuration error, normally 500. |
| TTL and adapter lifecycle | `ttl`, `processingTtl` and direct adapter calls accept integer seconds 1–2,147,483,647. Invalid TTL rejects before lookup/mutation. Only an unexpired PROCESSING owner can complete, once. | Audit old excessive TTLs and direct calls. Custom adapters must implement this range, validation order, logical expiry and atomic complete-once contract. Repeated/late completion returns `stale`, preserving the existing response/TTL. |
| Observability | `event.scope` is replaced by hashed `namespace`; `keyHash` changes with the encoded address. Original Error fields are replaced by fixed `code` and optional `operation`. | Update callbacks, dashboards and diagnostic consumers. Neither hash is a low-cardinality metric label or a raw-key lookup. Do not expect hash continuity across the upgrade. Callbacks remain best effort and unawaited. |
| Failure behavior | A successful handler whose capture fails passes through with `bypassed` and retained lease. Complete errors retain success without deletion; the completion write may already have committed. | Reconcile business outcomes, including after timeout/crash/expiry. Handler errors still attempt token-owned deletion, which does not prove business rollback. See [failure and recovery](failure-recovery.md). |

The option defaults stay `ttl: 86400`, `processingTtl: ttl`, `scope: 'endpoint'`,
`fingerprint: true`, `maxKeyLength: 255` and enabled status headers. There is no
new global 30-day webhook TTL, lease heartbeat, migration API or dual reader.
Memory supports long TTLs by splitting timer waits; 30 days is valid. A lease
expiry permits another acquisition; it never proves the original work stopped.

## Prepare the application and rollback artifact

Update database imports before compiling:

```ts
import {
  IDEMPOTENCY_STORAGE,
  IdempotencyModule,
  MemoryStorage,
  type IdempotencyEvent,
} from '@nestarc/idempotency';
import { RedisStorage } from '@nestarc/idempotency/redis';
import { PostgresStorage, PostgresSweepService } from '@nestarc/idempotency/postgres';
```

Only import the adapters used by the application. Memory needs no database
driver; Redis uses `npm install ioredis`; Postgres uses `npm install pg` and
`npm install --save-dev @types/pg`. The published SQL path is
`@nestarc/idempotency/sql/init.sql`. See the [adoption examples](../README.md)
for complete module wiring and external pool/client ownership.

Before the cutover, deploy application-owned durable deduplication to the old
version as well as the proposed new and rollback artifacts. A typical local
database design has a unique `(tenant_id, command_id)` row, the canonical
business parameters and result, with the business change in the same transaction.
An HTTP key alone is not this ledger. Commands sent to an external payment
provider also need provider deduplication and a reconciliation workflow for the
gap between provider success and the local commit.

Cover past successful commands and all still-possible redeliveries, not only
commands arriving after the ledger is introduced. Backfill from authoritative
business/provider evidence; a cache record alone cannot establish ownership or
prove that a side effect did or did not happen. Keep the ledger/inbox through
the application's redelivery horizon, including manual retry and rollback.
Reject an existing command ID carrying changed business parameters across both
versions; do not use a new HTTP key to bypass that check.

If old attempts cannot be mapped to durable identities and reconciled, keep
their redelivery blocked upstream and postpone migration until the delivery
window and unresolved work have been addressed. Waiting only for a cache TTL
or draining active requests does not satisfy this condition.

## Cutover procedure

1. Record the old/new/rollback artifact identifiers, configuration, storage
   locations, business ledger retention and responsible application owner.
   Rehearse with the selected artifacts before scheduling the deployment.
2. Pause ingress and scheduled/queue/webhook redelivery for affected commands.
   Fence every old writer, including workers and delayed jobs. Wait for active
   work and started storage writes to settle. A canceled request or a vanished
   pod is not evidence that its provider/database action stopped.
3. Reconcile outstanding commands against the business ledger and provider.
   Keep uncertain commands blocked; [recovery guidance](failure-recovery.md)
   covers commit-before-complete, lost acknowledgments and cancellation.
4. Verify that the new and rollback artifacts consult the same durable command
   history for both old and new commands. Confirm unchanged semantic parameter
   validation, authorization, and authenticated result retrieval.
5. Prepare and verify an empty, independent physical storage namespace using
   one of the procedures below. Keep old storage intact. The observation
   `event.namespace` is a scope hash, not a storage namespace setting.
6. Replace all serving writers while traffic remains paused. Configure the new
   namespace on all new nodes. Check initialization, guard/serializer ordering,
   connection ownership, normal request/replay and parameter mismatch.
7. Use reconciled test commands to confirm that a retry of an old successful
   command returns the established business result without another side effect,
   then that a new command replays correctly. Resume ingress and redelivery only
   after all old writers are fenced and these checks pass. Observe fixed outcome
   counts and business duplicate/pending counts without logging raw keys/bodies.

### PostgreSQL: create a separate table

Use a reviewed table name and the same schema as [sql/init.sql](../sql/init.sql).
The example must run with all writers to this new table fenced. It refuses to
reuse any existing table, creates the standard schema and checks that it is empty.
Run in the installed consumer project, with `DATABASE_URL` set through your
normal secret configuration. `IDEMPOTENCY_TABLE` is an application environment
variable, not an option the package reads automatically.

```sh
export IDEMPOTENCY_TABLE=idempotency_records_v1_20261007
node <<'NODE'
const { Pool } = require('pg');
const { PostgresStorage } = require('@nestarc/idempotency/postgres');
async function main() {
  const tableName = process.env.IDEMPOTENCY_TABLE;
  if (!process.env.DATABASE_URL || !/^[a-z][a-z0-9_]{0,39}$/.test(tableName || '')) {
    throw new Error('Set DATABASE_URL and a reviewed short IDEMPOTENCY_TABLE');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const existing = await pool.query('SELECT to_regclass($1) AS relation', [tableName]);
    if (existing.rows[0].relation !== null) throw new Error('Target table already exists');
    await PostgresStorage.createSchema(pool, tableName);
    const rows = await pool.query(`SELECT count(*)::int AS count FROM "${tableName}"`);
    if (rows.rows[0].count !== 0) throw new Error('Target table is not empty');
    console.log('Empty target table verified:', tableName);
  } finally {
    await pool.end();
  }
}
main().catch(() => { console.error('PostgreSQL namespace verification failed'); process.exitCode = 1; });
NODE
```

Configure the application with `new PostgresStorage({ pool, tableName })`, where
`tableName` is this same reviewed value. The pool owner closes the pool at
shutdown. A separate database is another option. Match the migration and runtime
database/schema search path; the adapter's `tableName` is one quoted identifier,
not a `schema.table` expression.

For historical context, an existing 0.2 installation missing response headers
needed the following 0.3 migration (substitute its reviewed table identifier):

```sql
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS response_headers JSONB;
```

Running `CREATE TABLE IF NOT EXISTS` does not add a missing column to an existing
table. A newly created 1.0 target already contains `response_headers`. There is
no additional 1.0 ALTER or data conversion, and no reason to remove this nullable
column during rollback. Keep business-ledger schema and history available to
both versions.

### Redis: verify an unused prefix or use a separate database

Choose a new prefix controlled by the application and fence old writers first.
With the selected Redis database in `REDIS_URL`, this check fails on any existing
key under the prefix. `SCAN` is not a snapshot under concurrent writes, so keep
the namespace quiescent until the new deployment owns it. Use only the reviewed
ASCII prefix accepted by the check; it deliberately excludes glob metacharacters.

```sh
export IDEMPOTENCY_PREFIX=orders_v1_20261007:
node <<'NODE'
const Redis = require('ioredis');
async function main() {
  const prefix = process.env.IDEMPOTENCY_PREFIX;
  if (!process.env.REDIS_URL || !/^[a-zA-Z0-9_:-]+:$/.test(prefix || '')) {
    throw new Error('Set REDIS_URL and a reviewed IDEMPOTENCY_PREFIX');
  }
  const client = new Redis(process.env.REDIS_URL);
  try {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
      if (keys.length) throw new Error('Target Redis prefix is not empty');
      cursor = next;
    } while (cursor !== '0');
    console.log('Empty target prefix verified:', prefix);
  } finally {
    await client.quit();
  }
}
main().catch(() => { console.error('Redis namespace verification failed'); process.exitCode = 1; });
NODE
```

Configure `new RedisStorage({ client, keyPrefix: prefix })` with that value;
the client owner closes its connection at shutdown. This environment variable
is application-owned. For Redis Cluster, verify the chosen namespace on every
primary using cluster-aware operations; this single-client check is not a
cluster-wide scan.

Changing `idem:` to `idem:v1:` alone does not establish isolation: an old global
raw key could start with `v1:` and already occupy that address. More generally,
an old global raw key can equal an entire new encoded key. A 0.4 JSON body at
that address produces 409, but a body already in S1 format can replay. The
version prefix does not prove the record's origin or authenticated owner.
Never let old writers continue writing into the selected new address space.

### Memory

Construct a new `MemoryStorage` instance and replace all old application
instances during the pause. It is empty and isolated from the old instance,
but loses records on restart and does not coordinate separate processes.
Durable business deduplication must live outside that process and survive both
deployment and rollback. Do not treat restart as a migration of old results.

## Rollback and unsupported combinations

Rollback is another coordinated cutover. Pause traffic/redelivery, fence new
writers, drain started work and reconcile uncertain commands. Retain the same
business ledger and parameter checks, including every command first handled by
1.0. Deploy a prepared rollback artifact into another verified empty namespace
with its own record format. Verify old and new command retries against the
ledger before resuming. Keep both previous namespaces for investigation under
the application's retention/access controls.

| Proposed operation | Support and reason |
| --- | --- |
| Full replacement after the cutover steps, empty namespace and complete durable command history | Supported migration procedure; the application must validate its own business/provider recovery. |
| Old/new writers process the same commands concurrently, including different prefixes/tables | Unsupported rolling deployment: independent locks allow both handlers to execute. |
| New reader uses old storage, or a dual-read fallback to old aliases | Unsupported: no reliable old identity provenance; legacy body compatibility and exact-address overlap also remain. |
| Old binary reads a namespace written by 1.0 | Unsupported: old JSON decoding cannot consume the new opaque body, and key/scope semantics differ. |
| Fresh namespace, cache flush, prefix rotation, restart or TTL expiry without durable command history | Unsupported: previous business operations can run again on a cache miss. |
| Rollback to an unmodified old artifact that bypasses the shared durable ledger | Unsupported, even if every new cache record expired. New-version business effects still exist. |
| New namespace and ledger, but pending provider work is simply assumed canceled | Unsupported: a canceled/expired attempt can still commit later. Reconcile or block that command. |
| Convert/copy old cache bodies and infer tenant/user from an old concatenated key | Unsupported: old records do not establish serialization safety or identity boundaries. |

Do not force-unlock PROCESSING, delete COMPLETED records or regenerate command
IDs to clear a 409/422 during either direction. Return confirmed results through
an authorized business reconciliation endpoint when cache replay is unavailable.

## Executable rehearsal and evidence boundary

From this repository, set `TEST_DATABASE_URL` to a disposable real PostgreSQL
service and run:

```sh
S7_REQUIRE_REAL_STORAGE=1 npm run test -- --runInBand \
  test/regression/adoption-migration.spec.ts \
  test/regression/request-isolation.spec.ts \
  test/regression/replay-body-format.spec.ts
```

The mandatory flag fails if the PG URL is absent. The new
[migration fixture](../test/regression/adoption-migration.spec.ts) uses separate
old/new/rollback PG tables plus a persistent unique business-command ledger and
transactional order effect. An old-format command crosses the new interceptor,
a new command crosses back to a modeled old reader, and each creates one
business effect. It also checks the old reader's failure on the new body and
demonstrates an exact legacy address overlap with an S1-compatible payload.

The fixture models 0.4 key/body behavior; it does not run an installed 0.4 binary
or a production orchestrator. Its atomic business effect is in PostgreSQL,
not an external provider. S3 tests additionally cover alias-only reexecution,
old JSON body 409 and namespace separation. S5 covers real process crashes and
uncertain writes. These checks support the procedure; rehearse the actual
application's two artifacts, ingress fencing, backups and provider recovery
before a production cutover. See [S7](1.0.0/work-items/S7-adoption-docs.md) for
the executed environment/results and S8 for final artifact/matrix validation.
