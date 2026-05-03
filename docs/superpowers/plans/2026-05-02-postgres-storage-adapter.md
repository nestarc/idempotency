# PostgreSQL Storage Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `PostgresStorage` as a third pluggable storage adapter for `@nestarc/idempotency`, alongside `MemoryStorage` and `RedisStorage`. Ships in v0.2.0.

**Architecture:** A new class `PostgresStorage` implementing `IdempotencyStorage` over a `pg.Pool`. Atomic NX semantics via `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now() RETURNING token`. Token-based CAS via `UPDATE/DELETE WHERE token = $`. Lazy expiration via `WHERE expires_at > now()` in `get()`. Optional `PostgresSweepService` for active cleanup (opt-in, advisory-lock guarded).

**Tech Stack:** NestJS 10/11, TypeScript 5.4, Jest 29, `pg ^8.11.0` (optional peer), Postgres 16 in CI.

**Reference:** Full design in [docs/postgres-storage-spec.md](../../postgres-storage-spec.md).

---

## File Structure

**Created files:**
- `sql/init.sql` — DDL bundled in the npm package
- `src/storage/postgres.storage.ts` — adapter implementation
- `src/services/postgres-sweep.service.ts` — opt-in sweep service
- `test/storage/postgres.storage.spec.ts` — adapter unit + shared contract
- `test/storage/postgres.storage.lifecycle.spec.ts` — Nest lifecycle regression
- `test/services/postgres-sweep.service.spec.ts` — sweep service tests
- `test/e2e/postgres.e2e-spec.ts` — full NestJS app over Postgres
- `test/regression/postgres-adapter.spec.ts` — re-runs the four v0.1.3 regressions against Postgres
- `docker-compose.yml` — local Postgres for tests
- `docs/superpowers/plans/2026-05-02-postgres-storage-adapter.md` — this plan

**Modified files:**
- `package.json` — `peerDependencies`, `peerDependenciesMeta`, `devDependencies`, `files`
- `src/index.ts` — re-export new symbols
- `bench/idempotency.bench.ts` — add Postgres scenarios F & G
- `.github/workflows/ci.yml` — Postgres service container, `TEST_DATABASE_URL`
- `README.md` — storage table, usage, migration, sweep
- `CHANGELOG.md` — v0.2.0 entry
- `docs/handover.md` — flip "future" → "shipped"

**Test environment policy:** All Postgres-touching tests check `process.env.TEST_DATABASE_URL`. If absent, the suite is skipped (`describe.skip`) so the existing `npm test` works without Docker. CI always provides the URL via the service container.

---

## Task 1: Add `pg` as optional peer + dev dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Inspect current peer/dev deps**

Run: `cat package.json | head -90`
Expected: `peerDependencies` block currently has `@nestjs/common`, `@nestjs/core`, `ioredis`, `reflect-metadata`, `rxjs`. `peerDependenciesMeta` lists only `ioredis` as optional.

- [ ] **Step 2: Add `pg` to peerDependencies and peerDependenciesMeta**

Edit `package.json` in the `peerDependencies` and `peerDependenciesMeta` sections:

```jsonc
"peerDependencies": {
  "@nestjs/common": "^10.0.0 || ^11.0.0",
  "@nestjs/core": "^10.0.0 || ^11.0.0",
  "ioredis": "^5.0.0",
  "pg": "^8.11.0",
  "reflect-metadata": "^0.1.13 || ^0.2.0",
  "rxjs": "^7.8.0"
},
"peerDependenciesMeta": {
  "ioredis": { "optional": true },
  "pg": { "optional": true }
},
```

- [ ] **Step 3: Add `pg` and `@types/pg` to devDependencies**

In `devDependencies`:

```jsonc
"@types/pg": "^8.11.0",
"pg": "^8.11.0",
```

- [ ] **Step 4: Add `sql` to the published files array**

In the top-level `files`:

```jsonc
"files": [
  "dist",
  "sql",
  "README.md",
  "LICENSE"
],
```

- [ ] **Step 5: Install + lockfile sync**

Run: `npm install`
Expected: `package-lock.json` updated, no errors.

- [ ] **Step 6: Verify type-check still passes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit code 0, no output.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add pg as optional peer dependency

Adds the foundation for PostgresStorage adapter (v0.2.0). Mirrors the
ioredis pattern: optional peer so MemoryStorage-only consumers see no
warnings. Bundles sql/ in the published tarball for the schema migration
helper."
```

---

## Task 2: Create the SQL DDL

**Files:**
- Create: `sql/init.sql`

- [ ] **Step 1: Verify directory does not exist**

Run: `ls -la sql/ 2>&1 || echo "missing"`
Expected: `missing` (we are creating it fresh).

- [ ] **Step 2: Create `sql/init.sql`**

Write `sql/init.sql`:

```sql
-- @nestarc/idempotency v0.2.0+ schema
-- Idempotent: safe to run multiple times.
-- Required Postgres version: 12+ (verified on 16).

CREATE TABLE IF NOT EXISTS idempotency_records (
  key            TEXT        PRIMARY KEY,
  token          UUID        NOT NULL,
  fingerprint    TEXT,
  status         TEXT        NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
  response_code  INT,
  response_body  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
  ON idempotency_records (expires_at);
```

- [ ] **Step 3: Lint with psql syntax check (if local Postgres available)**

Run (optional, only if `psql` is installed locally):
`docker run --rm -i postgres:16-alpine psql --no-psqlrc -c "$(cat sql/init.sql)" 2>&1 || echo "skipping local validation"`
Expected: either `CREATE TABLE` / `CREATE INDEX` notices, or skipped message.

- [ ] **Step 4: Commit**

```bash
git add sql/init.sql
git commit -m "feat(postgres): add bundled DDL for PostgresStorage

sql/init.sql is shipped in the npm tarball so consumers can apply
the schema with their own migration tooling (psql -f, Flyway, sqitch,
Liquibase). The same statements are also executed by the upcoming
PostgresStorage.createSchema() helper for code-driven setup."
```

---

## Task 3: Add docker-compose for local Postgres

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Verify file does not yet exist**

Run: `ls docker-compose.yml 2>&1 || echo "missing"`
Expected: `missing`.

- [ ] **Step 2: Create `docker-compose.yml`**

Write `docker-compose.yml`:

```yaml
# Local development & test Postgres for the PostgresStorage adapter.
# Usage:
#   docker compose up -d postgres
#   export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test
#   npm test
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: idempotency_test
    ports:
      - '5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U test -d idempotency_test']
      interval: 5s
      timeout: 5s
      retries: 10
```

- [ ] **Step 3: Add `docker-compose.yml` to `.npmignore`**

Read `.npmignore` and append (only if not already present):

```
docker-compose.yml
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .npmignore
git commit -m "chore(test): add docker-compose for local Postgres

Local-only convenience. Excluded from the published tarball via
.npmignore. CI uses GitHub Actions service containers instead."
```

---

## Task 4: Define `PostgresStorageOptions` and the empty class skeleton

**Files:**
- Create: `src/storage/postgres.storage.ts`

- [ ] **Step 1: Create the file with options interface and class shell**

Write `src/storage/postgres.storage.ts`:

```typescript
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { DatabaseError } from 'pg';
import type { Pool, PoolConfig } from 'pg';

import type {
  CompleteResponse,
  CreateResult,
  IdempotencyStorage,
  MutateResult,
} from '../interfaces/idempotency-storage.interface';
import type { IdempotencyRecord } from '../interfaces/idempotency-record.interface';

/**
 * Constructor options for {@link PostgresStorage}.
 *
 * Provide either a pre-built `pool` (recommended — lets the consumer manage
 * connection lifecycle) OR a `connection` config that the storage uses to
 * lazily build its own pool.
 */
export interface PostgresStorageOptions {
  /** A pre-built pg Pool. Wins over `connection` if both are supplied. */
  pool?: Pool;
  /** pg PoolConfig used to lazily construct an internal pool. */
  connection?: PoolConfig;
  /** Test-only seam: custom factory used in place of `new Pool(connection)`. */
  poolFactory?: (connection: PoolConfig) => Pool;
  /**
   * Table name used for idempotency records.
   * @default 'idempotency_records'
   */
  tableName?: string;
  /**
   * If true, run `CREATE TABLE IF NOT EXISTS` and matching index on
   * module init. Defaults to false. Recommended only for development.
   */
  autoCreateSchema?: boolean;
}

const DEFAULT_TABLE_NAME = 'idempotency_records';

/**
 * Postgres SQLSTATE for `invalid_text_representation` — raised when a value
 * cannot be cast to its target type (e.g. a non-UUID literal supplied for
 * a UUID column).
 */
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * True when `err` is a `DatabaseError` with SQLSTATE 22P02. Used to map
 * malformed token literals to the CAS-fail path so callers see `'stale'`
 * (or fall through to an existence check in `delete()`) instead of an
 * unrelated runtime exception.
 */
function isInvalidTextRepresentation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === PG_INVALID_TEXT_REPRESENTATION;
}

/**
 * Postgres-backed implementation of {@link IdempotencyStorage}.
 *
 * Stores each record as a row in `idempotency_records` (override via
 * `tableName`). Atomic NX is enforced by the primary-key constraint on
 * `key` combined with `INSERT ... ON CONFLICT DO UPDATE WHERE
 * expires_at < now()`. Token-based compare-and-set is enforced by
 * `WHERE token = $` clauses on `complete()` and `delete()`. Lazy
 * expiration is enforced by `WHERE expires_at > now()` in `get()`.
 *
 * For active cleanup of expired rows see {@link PostgresSweepService}.
 */
@Injectable()
export class PostgresStorage implements IdempotencyStorage, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly tableName: string;
  private readonly autoCreateSchema: boolean;

  constructor(options: PostgresStorageOptions) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.autoCreateSchema = options.autoCreateSchema ?? false;

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (options.connection) {
      const factory =
        options.poolFactory ??
        ((connection: PoolConfig): Pool => {
          // Lazy require so consumers without pg installed are unaffected
          // unless they actually exercise this code path.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const PgPool = require('pg').Pool as new (cfg: PoolConfig) => Pool;
          return new PgPool(connection);
        });
      this.pool = factory(options.connection);
      this.ownsPool = true;
    } else {
      throw new Error(
        'PostgresStorage: must supply either `pool` or `connection` options',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.autoCreateSchema) {
      await PostgresStorage.createSchema(this.pool, this.tableName);
    }
  }

  async get(_key: string): Promise<IdempotencyRecord | null> {
    throw new Error('not implemented');
  }

  async create(
    _key: string,
    _fingerprint: string | undefined,
    _ttlSeconds: number,
  ): Promise<CreateResult> {
    throw new Error('not implemented');
  }

  async complete(
    _key: string,
    _token: string,
    _response: CompleteResponse,
    _ttlSeconds: number,
  ): Promise<MutateResult> {
    throw new Error('not implemented');
  }

  async delete(_key: string, _token: string): Promise<MutateResult> {
    throw new Error('not implemented');
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /**
   * Idempotently creates the records table and supporting index.
   * Safe to call multiple times. Used by `autoCreateSchema=true` and
   * available as a public helper for code-driven migrations.
   */
  static async createSchema(
    pool: Pool,
    tableName: string = DEFAULT_TABLE_NAME,
  ): Promise<void> {
    const ident = quoteIdent(tableName);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${ident} (
        key            TEXT        PRIMARY KEY,
        token          UUID        NOT NULL,
        fingerprint    TEXT,
        status         TEXT        NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
        response_code  INT,
        response_body  TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at     TIMESTAMPTZ NOT NULL
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdent('idx_' + tableName + '_expires_at')}
        ON ${ident} (expires_at);
    `);
  }
}

/**
 * Quotes a Postgres identifier safely. We allow `tableName` to be a
 * user-provided string, so we must defend against injection. Postgres
 * doubles internal double-quotes inside `"..."`.
 *
 * Exported because `PostgresSweepService` (Task 12) reuses this single
 * canonical helper instead of inlining a less-strict variant.
 */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `PostgresStorage: invalid identifier ${JSON.stringify(name)}; ` +
        `must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
    );
  }
  return `"${name}"`;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/storage/postgres.storage.ts
git commit -m "feat(postgres): scaffold PostgresStorage class skeleton

Empty methods throw 'not implemented'. Constructor handles owned vs
consumer-supplied pool, mirroring the RedisStorage pattern. createSchema()
helper is wired up for the autoCreateSchema option (default off).
Identifier quoting guards against injection in the user-overridable
tableName option."
```

---

## Task 5: Plug into shared storage contract (RED)

**Files:**
- Create: `test/storage/postgres.storage.spec.ts`

- [ ] **Step 1: Create the spec file with shared contract harness**

Write `test/storage/postgres.storage.spec.ts`:

```typescript
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: jest runs spec files in parallel, so every PG
// spec uses its own table to avoid TRUNCATEs colliding across files. See
// Task 16 of the v0.2.0 plan for the rationale.
const TABLE_NAME = 'idempotency_records_contract';

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[postgres.storage.spec] TEST_DATABASE_URL not set — Postgres tests skipped.\n' +
      '  To run: docker compose up -d postgres && \\\n' +
      '          export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test',
  );
}

describeOrSkip('PostgresStorage', () => {
  let suitePool: Pool;

  beforeAll(async () => {
    suitePool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(suitePool, TABLE_NAME);
  });

  afterAll(async () => {
    await suitePool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await suitePool.end();
  });

  describeStorageContract('PostgresStorage', async () => {
    // Per-test isolation: TRUNCATE before each test.
    await suitePool.query(`TRUNCATE "${TABLE_NAME}"`);
    const storage = new PostgresStorage({ pool: suitePool, tableName: TABLE_NAME });
    return {
      storage,
      cleanup: async () => {
        // Don't call storage.close() here — the consumer-supplied pool is
        // reused across tests. afterAll() ends it once at the end.
        await suitePool.query(`TRUNCATE "${TABLE_NAME}"`);
      },
    };
  });
});
```

- [ ] **Step 2: Run the suite to confirm it fails (or skips cleanly)**

If you have Docker, start Postgres first:

```bash
docker compose up -d postgres
export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test
```

Run: `npx jest test/storage/postgres.storage.spec.ts -v`
Expected (with `TEST_DATABASE_URL`): all 10 contract tests FAIL with `Error: not implemented`.
Expected (without `TEST_DATABASE_URL`): suite is skipped, single warning logged, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add test/storage/postgres.storage.spec.ts
git commit -m "test(postgres): plug PostgresStorage into shared contract suite

All ten LSP invariants from shared-storage-contract.ts will run against
PostgresStorage. Currently failing — this is the RED phase. Skips
cleanly when TEST_DATABASE_URL is unset so existing dev workflows are
unaffected."
```

---

## Task 6: Implement `get()` (GREEN for get-related contract tests)

**Files:**
- Modify: `src/storage/postgres.storage.ts`

- [ ] **Step 1: Replace the `get()` body with a real implementation**

When replacing the `get()` body, rename the parameter from `_key` to `key` (the skeleton uses an underscore prefix to satisfy `noUnusedParameters`).

Replace the `async get(key)` method body:

```typescript
async get(key: string): Promise<IdempotencyRecord | null> {
  const result = await this.pool.query<{
    key: string;
    token: string;
    fingerprint: string | null;
    status: 'PROCESSING' | 'COMPLETED';
    response_code: number | null;
    response_body: string | null;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT key, token, fingerprint, status, response_code, response_body,
            created_at, expires_at
       FROM ${quoteIdent(this.tableName)}
       WHERE key = $1 AND expires_at > now()`,
    [key],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    key: row.key,
    token: row.token,
    fingerprint: row.fingerprint ?? undefined,
    status: row.status,
    statusCode: row.response_code ?? undefined,
    responseBody: row.response_body ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
```

- [ ] **Step 2: Run contract tests — `get()` on missing key should now PASS, others still FAIL**

Run: `npx jest test/storage/postgres.storage.spec.ts -v`
Expected: `get() on a missing key returns null` PASSES; others still fail (`create()` not implemented).

- [ ] **Step 3: Commit**

```bash
git add src/storage/postgres.storage.ts
git commit -m "feat(postgres): implement get() with lazy expiration

Filters expired rows via WHERE expires_at > now() so callers never see
records that should be gone — even before any active sweep runs."
```

---

## Task 7: Implement `create()` with NX + expired-replacement

**Files:**
- Modify: `src/storage/postgres.storage.ts`

- [ ] **Step 1: Replace the `create()` body**

When replacing the `create()` body, you must (a) add `import { randomUUID } from 'crypto';` to the imports at the top of the file, and (b) rename parameters `_key`, `_fingerprint`, `_ttlSeconds` to `key`, `fingerprint`, `ttlSeconds` in the signature.

Replace the `async create(...)` method body:

```typescript
async create(
  key: string,
  fingerprint: string | undefined,
  ttlSeconds: number,
): Promise<CreateResult> {
  const token = randomUUID();
  const result = await this.pool.query<{ token: string }>(
    `INSERT INTO ${quoteIdent(this.tableName)}
       (key, token, fingerprint, status, expires_at)
     VALUES ($1, $2, $3, 'PROCESSING', now() + ($4 || ' seconds')::interval)
     ON CONFLICT (key) DO UPDATE
       SET token = EXCLUDED.token,
           fingerprint = EXCLUDED.fingerprint,
           status = 'PROCESSING',
           response_code = NULL,
           response_body = NULL,
           created_at = now(),
           expires_at = EXCLUDED.expires_at
       WHERE ${quoteIdent(this.tableName)}.expires_at < now()
     RETURNING token`,
    [key, token, fingerprint ?? null, String(ttlSeconds)],
  );
  if (result.rowCount === 1) {
    return { acquired: true, token };
  }
  return { acquired: false };
}
```

- [ ] **Step 2: Run contract tests — `create()` cases should pass**

Run: `npx jest test/storage/postgres.storage.spec.ts -v`
Expected: tests `create() returns a token...`, `a second create()...`, and `get() on a missing key...` all PASS. `complete()` and `delete()` still fail.

- [ ] **Step 3: Commit**

```bash
git add src/storage/postgres.storage.ts
git commit -m "feat(postgres): implement atomic create() with NX semantics

Uses INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now() to
both enforce NX and transparently replace expired rows in a single
atomic statement. RETURNING with no rows distinguishes refused
conflicts from successful (re)acquisitions."
```

---

## Task 8: Implement `complete()` with token CAS + createdAt preservation

**Files:**
- Modify: `src/storage/postgres.storage.ts`

- [ ] **Step 1: Replace the `complete()` body**

When replacing the `complete()` body, rename the parameters from `_key`, `_token`, `_response`, `_ttlSeconds` to `key`, `token`, `response`, `ttlSeconds`.

The schema's `token UUID NOT NULL` column rejects non-UUID literals at parse time with Postgres error code `22P02` (`invalid_text_representation`) — and the shared contract tests deliberately use `'wrong-token'` (not a UUID) to drive the stale-token CAS path. Reuse the `isInvalidTextRepresentation(err)` helper introduced in Task 4 to wrap the query in a `try/catch` that maps `22P02` to `'stale'`: a token that cannot be a UUID cannot match any row, so this is semantically the CAS-fail path. Add an inline comment in the SQL string noting that `created_at` is intentionally absent from the SET clause — that omission is the mechanism that satisfies the `IdempotencyRecord.createdAt` invariant tested in the shared contract.

Replace the `async complete(...)` method body:

```typescript
async complete(
  key: string,
  token: string,
  response: CompleteResponse,
  ttlSeconds: number,
): Promise<MutateResult> {
  try {
    const result = await this.pool.query(
      // NOTE: created_at is intentionally NOT in the SET clause — leaving it
      // untouched preserves the IdempotencyRecord.createdAt invariant
      // (shared-storage-contract test "complete() preserves createdAt").
      `UPDATE ${quoteIdent(this.tableName)}
         SET status        = 'COMPLETED',
             response_code = $3,
             response_body = $4,
             expires_at    = now() + ($5 || ' seconds')::interval
         WHERE key = $1 AND token = $2 AND status = 'PROCESSING'`,
      [key, token, response.statusCode, response.body ?? null, String(ttlSeconds)],
    );
    return result.rowCount === 1 ? 'ok' : 'stale';
  } catch (err) {
    // A non-UUID token literal cannot match any row, so this is the
    // CAS-fail path → 'stale'. Valid-but-non-matching UUIDs are handled
    // via rowCount=0 above (no exception is thrown for them).
    if (isInvalidTextRepresentation(err)) return 'stale';
    throw err;
  }
}
```

- [ ] **Step 2: Run contract tests**

Run: `npx jest test/storage/postgres.storage.spec.ts -v`
Expected: all `complete()` related tests now PASS — including the `createdAt` preservation test (because `created_at` is intentionally absent from the SET clause). `delete()` tests still fail.

- [ ] **Step 3: Commit**

```bash
git add src/storage/postgres.storage.ts
git commit -m "feat(postgres): implement complete() with token CAS

Token check is enforced inside the UPDATE WHERE clause so the SQL
itself is the compare-and-set. created_at is omitted from the SET clause
so the IdempotencyRecord invariant is preserved automatically — the DB
keeps the original timestamp untouched. Defensive AND status =
'PROCESSING' guards against double-completion. Non-UUID token literals
(used by the shared contract's stale-token tests) raise Postgres code
22P02; we map that to 'stale' since a malformed token cannot match any
row."
```

---

## Task 9: Implement `delete()` with idempotent-cleanup semantics

**Files:**
- Modify: `src/storage/postgres.storage.ts`

- [ ] **Step 1: Replace the `delete()` body**

When replacing the `delete()` body, rename the parameters from `_key`, `_token` to `key`, `token`.

Same caveat as `complete()`: the `token UUID NOT NULL` column raises Postgres code `22P02` (`invalid_text_representation`) for non-UUID token literals, and the shared contract uses `'wrong-token'` to drive the stale-token path here too. Reuse the `isInvalidTextRepresentation(err)` helper introduced in Task 4 to wrap the DELETE in a `try/catch` that swallows `22P02` and falls through to the existence check — a malformed token cannot own any row, so the existence check correctly distinguishes "missing key → `'ok'`" from "row exists under a real UUID token → `'stale'`". This preserves the contract's wrong-token semantics without weakening the `UUID` column type. Set `deletedCount = 0` explicitly in the catch so the fall-through is unambiguous (do not rely on a default initialization).

Replace the `async delete(...)` method body:

```typescript
async delete(key: string, token: string): Promise<MutateResult> {
  let deletedCount: number;
  try {
    const del = await this.pool.query(
      `DELETE FROM ${quoteIdent(this.tableName)} WHERE key = $1 AND token = $2`,
      [key, token],
    );
    deletedCount = del.rowCount ?? 0;
  } catch (err) {
    if (!isInvalidTextRepresentation(err)) throw err;
    // Non-UUID token cannot own any row — same outcome as a CAS miss.
    // Fall through to the existence check below.
    deletedCount = 0;
  }
  if (deletedCount === 1) return 'ok';
  // 0 rows affected: either the key is missing (idempotent cleanup → 'ok')
  // or a different (real UUID) token owns the row (caller is stale → 'stale').
  const exists = await this.pool.query(
    `SELECT 1 FROM ${quoteIdent(this.tableName)} WHERE key = $1`,
    [key],
  );
  return exists.rowCount === 0 ? 'ok' : 'stale';
}
```

- [ ] **Step 2: Run contract tests — full suite should be GREEN now**

Run: `npx jest test/storage/postgres.storage.spec.ts -v`
Expected: ALL 10 shared contract tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/storage/postgres.storage.ts
git commit -m "feat(postgres): implement delete() with idempotent-cleanup

Two-step pattern: DELETE WHERE token matches first (fast path), then
SELECT to distinguish 'already absent' (ok) from 'different token owns
this row' (stale). Non-UUID token literals raise Postgres code 22P02;
the catch lets us fall through to the existence check so the
missing-key/different-token distinction is preserved without weakening
the UUID column type. Closes the shared storage contract — all 10 LSP
invariants now pass for PostgresStorage."
```

---

## Task 10: Add Postgres-specific lifecycle test

**Files:**
- Create: `test/storage/postgres.storage.lifecycle.spec.ts`

- [ ] **Step 1: Create the lifecycle spec**

Write `test/storage/postgres.storage.lifecycle.spec.ts`:

```typescript
/**
 * Lifecycle parity with RedisStorage:
 *  1. PostgresStorage implements OnModuleDestroy.
 *  2. When the storage owns its pool (constructed via `connection` /
 *     `poolFactory`), the hook calls pool.end() exactly once.
 *  3. When the consumer supplied their own `pool`, the hook does NOT
 *     call pool.end().
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { IdempotencyModule } from '../../src/idempotency.module';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: every PG spec uses its own table so jest's
// parallel test runner cannot cause TRUNCATEs to collide between specs.
const TABLE_NAME = 'idempotency_records_lifecycle';

describeOrSkip('PostgresStorage lifecycle', () => {
  it('closes the internally-owned pool via OnModuleDestroy when the Nest app shuts down', async () => {
    let factoryPool: Pool | undefined;

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({
            connection: { connectionString: TEST_DATABASE_URL },
            tableName: TABLE_NAME,
            poolFactory: (cfg): Pool => {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const PgPool = require('pg').Pool;
              factoryPool = new PgPool(cfg) as Pool;
              return factoryPool!;
            },
          }),
        }),
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();

    expect(factoryPool).toBeDefined();
    const endSpy = jest.spyOn(factoryPool!, 'end');

    await app.close();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT close a consumer-supplied pool on shutdown', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require('pg') as typeof import('pg');
    const consumerPool = new Pool({ connectionString: TEST_DATABASE_URL });
    const endSpy = jest.spyOn(consumerPool, 'end');

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({ pool: consumerPool, tableName: TABLE_NAME }),
        }),
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await app.close();

    expect(endSpy).not.toHaveBeenCalled();

    await consumerPool.end();
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npx jest test/storage/postgres.storage.lifecycle.spec.ts -v`
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test/storage/postgres.storage.lifecycle.spec.ts
git commit -m "test(postgres): regression test for OnModuleDestroy ownership

Mirrors the RedisStorage lifecycle suite. Locks the contract that an
internally-owned pool is closed on Nest shutdown, while a
consumer-supplied pool is left for the consumer to clean up."
```

---

## Task 11: Add Postgres-specific behavior tests (autoCreateSchema, tableName, expired replacement)

**Files:**
- Modify: `test/storage/postgres.storage.spec.ts`

- [ ] **Step 1: Append a Postgres-specific describe block to the existing spec**

Append to `test/storage/postgres.storage.spec.ts` (after the closing `});` of `describeOrSkip(...)`):

```typescript
describeOrSkip('PostgresStorage — Postgres-specific behavior', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE_NAME}"`);
  });

  it('create() replaces an expired row with a fresh PROCESSING record', async () => {
    const storage = new PostgresStorage({ pool, tableName: TABLE_NAME });
    // Seed a COMPLETED row with non-null statusCode/body so we can assert
    // they are cleared by the ON CONFLICT DO UPDATE branch.
    await pool.query(
      `INSERT INTO "${TABLE_NAME}"
         (key, token, fingerprint, status, response_code, response_body, expires_at)
       VALUES ('expired-key', gen_random_uuid(), 'old-fp', 'COMPLETED',
               200, '{"prior":"body"}', now() - interval '1 second')`,
    );

    const result = await storage.create('expired-key', 'new-fp', 60);
    expect(result.acquired).toBe(true);
    expect(typeof result.token).toBe('string');

    const row = await storage.get('expired-key');
    expect(row!.status).toBe('PROCESSING');
    expect(row!.fingerprint).toBe('new-fp');
    expect(row!.token).toBe(result.token);
    // Cleared on replacement (was 200 / '{"prior":"body"}' before).
    expect(row!.statusCode).toBeUndefined();
    expect(row!.responseBody).toBeUndefined();
  });

  it('createSchema() is idempotent — calling twice does not throw', async () => {
    await PostgresStorage.createSchema(pool, TABLE_NAME);
    await PostgresStorage.createSchema(pool, TABLE_NAME); // would throw on duplicate without IF NOT EXISTS
  });

  it('createSchema() rejects unsafe table names', async () => {
    await expect(
      PostgresStorage.createSchema(pool, 'evil; DROP TABLE x;--'),
    ).rejects.toThrow(/invalid identifier/);
  });

  it('honors a custom tableName option (creates and uses an alternate table)', async () => {
    const altTable = 'idempotency_alt';
    await PostgresStorage.createSchema(pool, altTable);
    try {
      const storage = new PostgresStorage({ pool, tableName: altTable });
      const created = await storage.create('alt-key', 'fp', 60);
      expect(created.acquired).toBe(true);
      const row = await storage.get('alt-key');
      expect(row!.fingerprint).toBe('fp');

      // Suite's main table should be untouched.
      const main = await pool.query(
        `SELECT count(*)::int AS c FROM "${TABLE_NAME}" WHERE key = $1`,
        ['alt-key'],
      );
      expect(main.rows[0].c).toBe(0);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${altTable}"`);
    }
  });

  it('autoCreateSchema=true creates the table on module init when missing', async () => {
    // Drop our suite-private table to simulate a fresh DB.
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    try {
      const storage = new PostgresStorage({
        pool,
        tableName: TABLE_NAME,
        autoCreateSchema: true,
      });
      await storage.onModuleInit();

      const exists = await pool.query<{ to_regclass: string | null }>(
        `SELECT to_regclass($1) AS to_regclass`,
        [TABLE_NAME],
      );
      expect(exists.rows[0].to_regclass).toBe(TABLE_NAME);
    } finally {
      // Restore the suite's table even on assertion failure so the next test
      // (or the next jest run after a failed run) starts from a known state.
      await PostgresStorage.createSchema(pool, TABLE_NAME);
    }
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npx jest test/storage/postgres.storage.spec.ts -v`
Expected: shared contract (10) + new Postgres-specific (5) all PASS.

- [ ] **Step 3: Commit**

```bash
git add test/storage/postgres.storage.spec.ts
git commit -m "test(postgres): cover expired-replacement, tableName, autoCreateSchema

Pins down behavior unique to the Postgres adapter that the shared
contract does not exercise. Includes injection-defense regression for
tableName quoting."
```

---

## Task 12: Implement `PostgresSweepService`

**Files:**
- Create: `src/services/postgres-sweep.service.ts`
- Create: `test/services/postgres-sweep.service.spec.ts`
- Modify: `src/idempotency.constants.ts`

Adds `IDEMPOTENCY_SWEEP_OPTIONS = Symbol(...)` to `src/idempotency.constants.ts`
alongside the existing `IDEMPOTENCY_OPTIONS` and `IDEMPOTENCY_STORAGE` Symbols.
Symbol tokens are collision-free across module boundaries; string tokens
silently resolve to whichever provider was registered first.

- [ ] **Step 1: Create the test first (RED)**

Write `test/services/postgres-sweep.service.spec.ts`:

```typescript
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import {
  PostgresSweepService,
  type SweepOptions,
} from '../../src/services/postgres-sweep.service';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: jest runs spec files in parallel; each PG spec
// uses its own table so TRUNCATEs cannot stomp on a sibling spec mid-test.
// The sweep service reads `this.storage.tableName` internally, so passing
// the unique tableName into the storage flows through to the DELETE.
const TABLE_NAME = 'idempotency_records_sweep';

describeOrSkip('PostgresSweepService', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE_NAME}"`);
  });

  const seed = async (key: string, expiresOffsetMs: number): Promise<void> => {
    await pool.query(
      `INSERT INTO "${TABLE_NAME}"
         (key, token, fingerprint, status, expires_at)
       VALUES ($1, gen_random_uuid(), 'fp', 'COMPLETED',
               now() + ($2 || ' milliseconds')::interval)`,
      [key, String(expiresOffsetMs)],
    );
  };

  const buildService = (opts?: Partial<SweepOptions>): PostgresSweepService => {
    const storage = new PostgresStorage({ pool, tableName: TABLE_NAME });
    return new PostgresSweepService(storage, {
      enabled: true,
      intervalMs: 60_000,
      ...opts,
    });
  };

  it('deletes only expired rows', async () => {
    await seed('expired-1', -1000);
    await seed('expired-2', -1000);
    await seed('active', 60_000);

    const svc = buildService();
    const result = await svc.sweep();
    expect(result.deleted).toBe(2);

    const remaining = await pool.query<{ key: string }>(
      `SELECT key FROM "${TABLE_NAME}" ORDER BY key`,
    );
    expect(remaining.rows.map((r) => r.key)).toEqual(['active']);
  });

  it('does nothing when there are no expired rows', async () => {
    await seed('active', 60_000);
    const svc = buildService();
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
  });

  it('disabled service does NOT schedule a timer on init', async () => {
    const svc = buildService({ enabled: false });
    await svc.onModuleInit();
    // Direct introspection: the internal timer field must be undefined.
    expect((svc as unknown as { timer: NodeJS.Timeout | undefined }).timer).toBeUndefined();
    await svc.onModuleDestroy();
    // Manual sweep should still work even when scheduling is disabled.
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
  });

  it('clears the interval on onModuleDestroy', async () => {
    jest.useFakeTimers();
    try {
      const svc = buildService({ intervalMs: 1000 });
      await svc.onModuleInit();
      const internal = svc as unknown as { timer?: NodeJS.Timeout };
      expect(internal.timer).toBeDefined();

      await svc.onModuleDestroy();
      // Advancing time after destroy must not trigger sweep. The timer
      // reference is left intact (we just clearInterval'd it), so we
      // verify quiescence via Jest's pending-timer count semantics.
      jest.advanceTimersByTime(5000);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run — should fail with import error (RED)**

Run: `npx jest test/services/postgres-sweep.service.spec.ts -v`
Expected: failure with `Cannot find module '../../src/services/postgres-sweep.service'`.

- [ ] **Step 3: Create the service implementation**

Write `src/services/postgres-sweep.service.ts`:

```typescript
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { IDEMPOTENCY_SWEEP_OPTIONS } from '../idempotency.constants';
import { PostgresStorage, quoteIdent } from '../storage/postgres.storage';

export interface SweepOptions {
  /** When false, the service is wired up but never schedules a sweep. */
  enabled: boolean;
  /** Sweep cadence. Defaults to 60_000 (1 minute). */
  intervalMs?: number;
}

const SWEEP_LOCK_KEY = 'idempotency-sweep';

/**
 * Optional service that periodically deletes expired idempotency records.
 *
 * Lazy expiration in {@link PostgresStorage.get} already guarantees
 * correctness; this service exists only to keep disk usage and dead
 * tuples bounded in long-running deployments.
 *
 * Multi-instance safety: each sweep wraps DELETE in
 * `pg_try_advisory_lock(hashtext('idempotency-sweep'))`. Concurrent
 * replicas will see a lock contention and skip — no DELETE storms.
 */
@Injectable()
export class PostgresSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresSweepService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly storage: PostgresStorage,
    @Optional()
    @Inject(IDEMPOTENCY_SWEEP_OPTIONS)
    private readonly options: SweepOptions = { enabled: false },
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.enabled) return;
    const interval = this.options.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`sweep failed: ${(err as Error).message}`, err as Error),
      );
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Runs one sweep cycle. Returns the number of rows deleted (0 if another
   * replica holds the advisory lock for this cycle).
   */
  async sweep(): Promise<{ deleted: number }> {
    const pool = this.storage.pool;
    const tableName = this.storage.tableName;
    const ident = quoteIdent(tableName);

    const client = await pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
        [SWEEP_LOCK_KEY],
      );
      if (!lock.rows[0].acquired) {
        return { deleted: 0 };
      }
      try {
        const del = await client.query(
          `DELETE FROM ${ident} WHERE expires_at < now()`,
        );
        return { deleted: del.rowCount ?? 0 };
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
          SWEEP_LOCK_KEY,
        ]);
      }
    } finally {
      client.release();
    }
  }
}
```

- [ ] **Step 4: Expose `pool` and `tableName` to the sweep service safely; export `quoteIdent` for reuse**

Modify `src/storage/postgres.storage.ts` — change the field visibility from `private readonly` to `readonly` (package-internal) for `pool` and `tableName`:

Replace:
```typescript
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly tableName: string;
  private readonly autoCreateSchema: boolean;
```
with:
```typescript
  /** @internal */ readonly pool: Pool;
  private readonly ownsPool: boolean;
  /** @internal */ readonly tableName: string;
  private readonly autoCreateSchema: boolean;
```

Also promote the existing module-level `quoteIdent(name)` helper from `function quoteIdent(...)` to `export function quoteIdent(...)`. The sweep service reuses this single canonical helper instead of inlining a less-strict variant — keeping the identifier-shape regex and double-quote escape in one place.

The sweep service in Step 3 already imports and calls `quoteIdent` directly, so no additional edits are needed in the service file once `quoteIdent` is exported. The body of `sweep()` reads as:

```typescript
const pool = this.storage.pool;
const tableName = this.storage.tableName;
const ident = quoteIdent(tableName);
```

- [ ] **Step 5: Run sweep tests**

Run: `npx jest test/services/postgres-sweep.service.spec.ts -v`
Expected: all 4 tests PASS.

- [ ] **Step 6: Run the full suite to verify no regression**

Run: `npm test`
Expected: full unit suite green.

- [ ] **Step 7: Commit**

```bash
git add src/services/postgres-sweep.service.ts \
        src/storage/postgres.storage.ts \
        test/services/postgres-sweep.service.spec.ts
git commit -m "feat(postgres): add opt-in PostgresSweepService

Active deletion of expired records, opt-in via SweepOptions.enabled.
Multi-instance safe: each cycle wraps DELETE in pg_try_advisory_lock so
concurrent replicas serialize cleanly. Lazy expiration in get() already
guarantees correctness — this service only manages disk hygiene."
```

---

## Task 13: Re-export new symbols

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add exports for `PostgresStorage`, options, and the sweep service**

Edit `src/index.ts`. Replace the storage adapters block:

```typescript
// Storage adapters
export { MemoryStorage } from './storage/memory.storage';
export { RedisStorage, type RedisStorageOptions } from './storage/redis.storage';
export {
  PostgresStorage,
  type PostgresStorageOptions,
} from './storage/postgres.storage';

// Optional services
export {
  PostgresSweepService,
  type SweepOptions,
} from './services/postgres-sweep.service';
```

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(postgres): export PostgresStorage and PostgresSweepService"
```

---

## Task 14: E2E test against a real Postgres

**Files:**
- Create: `test/e2e/postgres.e2e-spec.ts`

- [ ] **Step 1: Inspect existing e2e patterns**

Run: `ls test/e2e/`
Expected: at least one `*.e2e-spec.ts` file (likely `idempotency.e2e-spec.ts`).

Run: `head -100 test/e2e/idempotency.e2e-spec.ts`
Expected: pattern using `Test.createTestingModule`, `supertest`, controller fixtures.

- [ ] **Step 2: Create the Postgres e2e**

Write `test/e2e/postgres.e2e-spec.ts`. Note: `IdempotencyModule.forRoot` is intentionally non-magic — consumers explicitly choose between `APP_INTERCEPTOR` (global), controller-scope, or method-scope registration. The e2e test uses `APP_INTERCEPTOR` for parity with the existing `test/e2e/idempotency.e2e-spec.ts` pattern; without this wiring the interceptor never fires and every test would fall through to the raw handler.

```typescript
import 'reflect-metadata';
import { INestApplication, Module, Controller, Post, Body } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';

import {
  IdempotencyInterceptor,
  IdempotencyModule,
  Idempotent,
  PostgresStorage,
} from '../../src';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: jest runs spec files in parallel; each PG spec
// uses its own table so TRUNCATEs cannot stomp on a sibling spec mid-test.
const TABLE_NAME = 'idempotency_records_e2e';

@Controller('payments')
class PaymentsController {
  static calls = 0;

  @Post()
  @Idempotent()
  charge(@Body() body: { amount: number }): { id: string; amount: number } {
    PaymentsController.calls += 1;
    return { id: `txn-${PaymentsController.calls}`, amount: body.amount };
  }
}

describeOrSkip('PostgresStorage e2e', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE_NAME}"`);
    PaymentsController.calls = 0;

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          storage: new PostgresStorage({ pool, tableName: TABLE_NAME }),
        }),
      ],
      controllers: [PaymentsController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('replays the cached response on repeat with the same key + body', async () => {
    const r1 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k1')
      .send({ amount: 100 });
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({ id: 'txn-1', amount: 100 });

    const r2 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k1')
      .send({ amount: 100 });
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual({ id: 'txn-1', amount: 100 });

    expect(PaymentsController.calls).toBe(1);
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k2')
      .send({ amount: 100 })
      .expect(201);

    const r2 = await request(app.getHttpServer())
      .post('/payments')
      .set('Idempotency-Key', 'k2')
      .send({ amount: 999 });
    expect(r2.status).toBe(422);
  });

  it('two concurrent requests result in exactly one handler execution', async () => {
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'k3')
        .send({ amount: 100 }),
      request(app.getHttpServer())
        .post('/payments')
        .set('Idempotency-Key', 'k3')
        .send({ amount: 100 }),
    ]);

    expect(PaymentsController.calls).toBe(1);
    const statuses = [r1.status, r2.status].sort();
    // Either both replayed, or one 201 + one 409.
    expect(
      JSON.stringify(statuses) === '[201,201]' ||
        JSON.stringify(statuses) === '[201,409]',
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run e2e**

Run: `npm run test:e2e -- --testPathPattern=postgres`
Expected: all 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/postgres.e2e-spec.ts
git commit -m "test(postgres): e2e coverage for replay, fingerprint, and concurrency

Boots a real NestJS app over a real Postgres (skipped when
TEST_DATABASE_URL is unset). Verifies the three signature behaviors:
replay on repeat, 422 on body mismatch, and at-most-once handler
execution under Promise.all concurrency."
```

---

## Task 15: Re-run existing regression suite against PostgresStorage

**Files:**
- Create: `test/regression/postgres-adapter.spec.ts`

- [ ] **Step 1: Inspect the four v0.1.3 regression tests**

Run: `ls test/regression/`
Expected: files like `complete-failure-cascade.spec.ts`, `race-completed-winner.spec.ts`, `path-based-scope.spec.ts`, `ttl-validation.spec.ts`.

Run: `head -40 test/regression/complete-failure-cascade.spec.ts`
Expected: see the storage construction pattern (likely uses MemoryStorage / FakeStorage).

- [ ] **Step 2: Create a Postgres-targeted regression spec**

The existing regression tests are pure interceptor-level tests using FakeStorage to inject failures. Most of them are storage-agnostic and don't need re-running. The one that DOES exercise real adapter semantics is the race-completed-winner scenario. Re-run that scenario against a live Postgres to lock in adapter-level correctness.

Write `test/regression/postgres-adapter.spec.ts`:

```typescript
/**
 * Re-runs the storage-sensitive subset of the v0.1.3 regression suite
 * against a real PostgresStorage. The interceptor-level regressions that
 * use FakeStorage stay untouched — they exercise the interceptor itself,
 * not adapter semantics.
 *
 * This file pins down two adapter-level invariants:
 *   1. Token CAS holds across `complete()` after TTL eviction.
 *   2. Two concurrent `create()` calls under contention yield exactly
 *      one acquired:true and one acquired:false (NX semantics).
 */
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres.storage';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Per-spec table isolation: jest runs spec files in parallel; each PG spec
// uses its own table so TRUNCATEs cannot stomp on a sibling spec mid-test.
const TABLE_NAME = 'idempotency_records_regression';

describeOrSkip('PostgresStorage v0.1.3 regression parity', () => {
  let pool: Pool;
  let storage: PostgresStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await PostgresStorage.createSchema(pool, TABLE_NAME);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE_NAME}"`);
    storage = new PostgresStorage({ pool, tableName: TABLE_NAME });
  });

  it('race-completed-winner: complete() after expired-replacement returns stale', async () => {
    const { token: oldToken } = await storage.create('rk', 'fp', 60);

    // Force the row to be expired so a fresh create() can replace it.
    await pool.query(
      `UPDATE "${TABLE_NAME}" SET expires_at = now() - interval '1 second'
       WHERE key = 'rk'`,
    );

    const second = await storage.create('rk', 'fp', 60);
    expect(second.acquired).toBe(true);
    expect(second.token).not.toBe(oldToken);

    // The original caller's complete() must report stale — they no longer
    // own the row.
    const stale = await storage.complete(
      'rk',
      oldToken!,
      { statusCode: 200, body: '{}' },
      60,
    );
    expect(stale).toBe('stale');

    // The new owner can still complete normally.
    const ok = await storage.complete(
      'rk',
      second.token!,
      { statusCode: 200, body: '{}' },
      60,
    );
    expect(ok).toBe('ok');
  });

  it('NX semantics under concurrent creation: exactly one wins', async () => {
    const fps = ['fp1', 'fp2', 'fp3', 'fp4', 'fp5'];
    const results = await Promise.all(
      fps.map((fp) => storage.create('cc', fp, 60)),
    );

    const winners = results.filter((r) => r.acquired);
    const losers = results.filter((r) => !r.acquired);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    // Tightened: losers must NOT carry a token (interface contract).
    losers.forEach((r) => expect(r.token).toBeUndefined());

    // The stored row's token AND fingerprint must match the same winning
    // call. Without the fingerprint check, an adapter regression that
    // recorded the right token alongside a different call's fingerprint
    // would pass — this assertion locks down end-to-end consistency.
    const winnerIdx = results.findIndex((r) => r.acquired);
    const row = await storage.get('cc');
    expect(row!.token).toBe(winners[0].token);
    expect(row!.fingerprint).toBe(fps[winnerIdx]);
  });
});
```

- [ ] **Step 3: Run**

Run: `npx jest test/regression/postgres-adapter.spec.ts -v`
Expected: both tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/regression/postgres-adapter.spec.ts
git commit -m "test(regression): adapter-level parity for v0.1.3 invariants

Locks in token CAS after expired-replacement and NX semantics under
contention for PostgresStorage. The interceptor-level regression tests
remain unchanged — they continue to exercise the interceptor itself
through FakeStorage and need no per-adapter copies."
```

---

## Task 16: Update CI to run Postgres tests + fix cross-spec race condition

This task does two things in the same commit:

1. **Add Postgres service container to CI** — wire `TEST_DATABASE_URL` into the unit + e2e + coverage test steps so the PG suites run in CI.
2. **Fix the cross-spec table collision** — when multiple PG specs run in parallel, they share the same `idempotency_records` table and TRUNCATE each other. Approach: each PG spec uses its own `tableName` so they cannot collide, regardless of test parallelism.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `test/storage/postgres.storage.spec.ts`
- Modify: `test/storage/postgres.storage.lifecycle.spec.ts`
- Modify: `test/services/postgres-sweep.service.spec.ts`
- Modify: `test/regression/postgres-adapter.spec.ts`
- Modify: `test/e2e/postgres.e2e-spec.ts`

(All 5 PG spec files get a unique `tableName` so they never collide with one another or with concurrent CI workers.)

- [ ] **Step 1: Add the `postgres` service to the `test` job**

Edit `.github/workflows/ci.yml`. In the `jobs.test` block, just under `runs-on: ubuntu-latest`, add a `services` block, and add `TEST_DATABASE_URL` to the environment of the unit + e2e steps.

After the `runs-on: ubuntu-latest` line and before the `strategy:` block of the `test` job, add:

```yaml
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: idempotency_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U test -d idempotency_test"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
```

- [ ] **Step 2: Wire TEST_DATABASE_URL into test steps**

In the `test` job, modify the `Unit tests`, `E2E tests`, and `Coverage (primary cell only)` steps to set the env var:

```yaml
      - name: Unit tests
        env:
          TEST_DATABASE_URL: postgresql://test:test@localhost:5432/idempotency_test
        run: npm run test

      - name: E2E tests
        env:
          TEST_DATABASE_URL: postgresql://test:test@localhost:5432/idempotency_test
        run: npm run test:e2e

      - name: Coverage (primary cell only)
        if: matrix.node == '20' && matrix.nestjs == '11'
        env:
          TEST_DATABASE_URL: postgresql://test:test@localhost:5432/idempotency_test
        run: npm run test:cov
```

- [ ] **Step 3: Fix cross-spec table collision via unique tableName per spec**

Each PG spec currently uses the default `idempotency_records` table. When jest runs them in parallel (default for `npm test`), they collide — one spec's `TRUNCATE` blows away another spec's seeded fixture. The fix is to give each spec its own table name. The `tableName` option already exists on `PostgresStorage` and `createSchema(pool, tableName)`, so the change is purely in test code.

The 5 spec files and their suffixes:

- `test/storage/postgres.storage.spec.ts` → suffix `contract` (table name `idempotency_records_contract`)
- `test/storage/postgres.storage.lifecycle.spec.ts` → suffix `lifecycle` (`idempotency_records_lifecycle`)
- `test/services/postgres-sweep.service.spec.ts` → suffix `sweep` (`idempotency_records_sweep`)
- `test/regression/postgres-adapter.spec.ts` → suffix `regression` (`idempotency_records_regression`)
- `test/e2e/postgres.e2e-spec.ts` → suffix `e2e` (`idempotency_records_e2e`)

For each spec file:

1. Define a per-spec const near the top: `const TABLE_NAME = 'idempotency_records_<suffix>';`.
2. Pass it to `PostgresStorage.createSchema(pool, TABLE_NAME)` in `beforeAll`.
3. Pass `{ pool, tableName: TABLE_NAME }` (alongside any other existing options) into every `new PostgresStorage(...)` call in the spec.
4. Replace every literal `idempotency_records` reference (raw SQL: TRUNCATE / INSERT / UPDATE / SELECT / DROP TABLE / `to_regclass(...)`) with a template literal using `TABLE_NAME` (e.g. `` `TRUNCATE "${TABLE_NAME}"` ``). Keep parameterized binds (e.g. `$1`) for the *values*; only the *identifier* moves into the template literal.
5. Drop the unique table in `afterAll` so successive test runs do not accumulate dead tables.

Special cases inside `postgres.storage.spec.ts`:

- The `autoCreateSchema=true creates the table on module init when missing` test must drop and re-create the SAME `TABLE_NAME` it tests against — not the hardcoded default. Update the `to_regclass` call to use the parameterized form `to_regclass($1)` with `[TABLE_NAME]` and the cleanup `createSchema(pool, TABLE_NAME)` call so the suite restores its own table on success or failure.
- The `honors a custom tableName option` test that uses `'idempotency_alt'` is INTENTIONALLY testing a different table from the suite default. Leave the alt-table name as-is (it's exercising the option itself), but update the "default table should be untouched" assertion to query the suite's `TABLE_NAME` instead of the hardcoded `idempotency_records`.

Special cases inside `postgres-sweep.service.spec.ts`:

- The sweep service reads `this.storage.tableName` to build its DELETE SQL. So as long as the test passes `{ pool, tableName: TABLE_NAME }` into the `PostgresStorage` instance the service receives, the sweep DELETE will target the right table. The `seed(...)` helper that does a raw `INSERT INTO idempotency_records` must be updated to use `TABLE_NAME`. The "remaining rows" assertion's raw `SELECT FROM idempotency_records` must also use `TABLE_NAME`.

Special cases inside `postgres-adapter.spec.ts` (regression):

- The `race-completed-winner` test has a raw `UPDATE idempotency_records SET expires_at = ...`. Update the table name in the UPDATE to use `TABLE_NAME`.

Special cases inside `postgres.e2e-spec.ts`:

- The `storage: new PostgresStorage({ pool, tableName: TABLE_NAME })` is what the controller / interceptor will use, so the IdempotencyInterceptor automatically uses the right table — no controller-level changes needed.

- [ ] **Step 4: Validate the workflow file syntactically**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml', 'utf8'))"` (or the python alternative `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`).
Expected: no error.

- [ ] **Step 5: Run all PG specs in parallel — they should NO LONGER collide**

```bash
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/idempotency_test \
  npx jest test/storage/postgres.storage.spec.ts \
           test/storage/postgres.storage.lifecycle.spec.ts \
           test/services/postgres-sweep.service.spec.ts \
           test/regression/postgres-adapter.spec.ts \
           --verbose 2>&1 | tail -30
```
Expected: ALL 23 tests pass (15 contract+spec + 2 lifecycle + 4 sweep + 2 regression). No flakiness, no race-related failures.

Run the full unit suite to confirm no regression:

```bash
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/idempotency_test \
  npm test -- --selectProjects unit 2>&1 | tail -10
```
Expected: 132 passing (109 baseline + 23 PG), 0 skipped.

Run with env unset:

```bash
unset TEST_DATABASE_URL
npm test -- --selectProjects unit 2>&1 | tail -10
```
Expected: 109 passing + 23 skipped — unchanged.

Run e2e:

```bash
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/idempotency_test \
  npm run test:e2e 2>&1 | tail -10
```
Expected: existing e2e + new postgres e2e all pass.

After verification, drop the test tables (use the unique table names you defined):

```bash
docker exec -i idempotency-test-pg psql -U test -d idempotency_test -c "
  DROP TABLE IF EXISTS idempotency_records_contract;
  DROP TABLE IF EXISTS idempotency_records_lifecycle;
  DROP TABLE IF EXISTS idempotency_records_sweep;
  DROP TABLE IF EXISTS idempotency_records_regression;
  DROP TABLE IF EXISTS idempotency_records_e2e;
  DROP TABLE IF EXISTS idempotency_records;
  DROP TABLE IF EXISTS idempotency_alt;
"
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml \
        test/storage/postgres.storage.spec.ts \
        test/storage/postgres.storage.lifecycle.spec.ts \
        test/services/postgres-sweep.service.spec.ts \
        test/regression/postgres-adapter.spec.ts \
        test/e2e/postgres.e2e-spec.ts
git commit -m "ci(postgres): run PG suite in CI and isolate via per-spec tableName

Two changes that belong together:

1. CI workflow: adds a postgres:16-alpine service container and wires
   TEST_DATABASE_URL into the unit, e2e, and coverage steps so the
   Postgres suites are exercised across the full Node × NestJS matrix.

2. Per-spec tableName isolation: each Postgres spec file now uses its
   own table (idempotency_records_contract, _lifecycle, _sweep,
   _regression, _e2e). Without this, jest's parallel test runner had
   the five specs share one table and TRUNCATE each other between
   tests — producing intermittent failures locally. Per-spec tables
   eliminate the race entirely without --runInBand or maxWorkers
   constraints, keeping unit suite throughput intact."
```

---

## Task 17: Add Postgres scenarios to the benchmark script

**Files:**
- Modify: `bench/idempotency.bench.ts`

- [ ] **Step 1: Inspect the current bench**

Run: `head -80 bench/idempotency.bench.ts`
Expected: existing scenarios A–E for baseline, MemoryStorage, RedisStorage.

- [ ] **Step 2: Add Postgres scenarios F & G**

Find the closing of the existing `runScenarios()` array (or equivalent — it depends on the file's actual structure). Append two scenarios analogous to D & E but using `PostgresStorage`. Use `TEST_DATABASE_URL` env (or accept a `--postgres-url` CLI flag mirroring `--redis-url`).

Add near the top, alongside the existing imports:

```typescript
import { Pool } from 'pg';
import { PostgresStorage } from '../src/storage/postgres.storage';
```

Add CLI flag parsing alongside the existing `--redis-url`:

```typescript
const postgresUrlIdx = process.argv.indexOf('--postgres-url');
const POSTGRES_URL =
  postgresUrlIdx >= 0
    ? process.argv[postgresUrlIdx + 1]
    : process.env.TEST_DATABASE_URL;
```

Add the two scenarios after the existing Redis ones, conditional on `POSTGRES_URL` being set:

```typescript
if (POSTGRES_URL) {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  await PostgresStorage.createSchema(pool);
  await pool.query('TRUNCATE idempotency_records');
  const pgStorage = new PostgresStorage({ pool });

  scenarios.push({
    name: 'F) First request — PostgresStorage',
    setup: async (i: number) => ({ key: `pg-first-${RUN_ID}-${i}` }),
    run: async (ctx) => doFirstRequest(pgStorage, ctx.key),
  });

  scenarios.push({
    name: 'G) Replay — PostgresStorage',
    setup: async (i: number) => {
      const key = `pg-replay-${RUN_ID}-${i}`;
      await primeCompleted(pgStorage, key);
      return { key };
    },
    run: async (ctx) => doReplayRequest(pgStorage, ctx.key),
  });

  // Tag-along teardown so the bench process exits cleanly.
  process.on('beforeExit', async () => {
    await pool.end();
  });
}
```

> **Note:** the exact names `doFirstRequest`, `doReplayRequest`, `primeCompleted`, `RUN_ID`, and the scenario object shape depend on what is already in `bench/idempotency.bench.ts`. Inspect first; mirror the names used by the existing D/E scenarios. If the bench uses a different abstraction, adapt these snippets to match — the goal is two scenarios paralleling D/E but pointing at `PostgresStorage`.

- [ ] **Step 3: Smoke-run the bench (optional)**

Run (only if Docker Postgres is available):

```bash
TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test \
  npx ts-node bench/idempotency.bench.ts --iterations 20 --warmup 5
```
Expected: scenarios A–G all print stats.

- [ ] **Step 4: Commit**

```bash
git add bench/idempotency.bench.ts
git commit -m "perf(bench): add Postgres first-request and replay scenarios

Scenarios F and G mirror the existing Redis D and E. Activated when
--postgres-url or TEST_DATABASE_URL is supplied. Lets us compare
Memory vs Redis vs Postgres latency profiles head-to-head."
```

---

## Task 18: Update README, CHANGELOG, and handover doc

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/handover.md`

- [ ] **Step 1: Add Postgres to the storage comparison in README**

Edit `README.md`. Find the section that introduces storage adapters (search for "RedisStorage" — it's near the install/quickstart block). Add a Postgres column or row to the comparison table, and add a "PostgresStorage" usage block analogous to the existing Redis one.

Insert after the Redis usage block:

````markdown
### PostgreSQL storage

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

#### Schema migration

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
   new PostgresStorage({ pool, autoCreateSchema: true })
   ```

#### Optional sweep service

Lazy expiration on `get()` already guarantees correctness. The sweep
service exists only to bound disk usage in long-running deployments:

```ts
import {
  IDEMPOTENCY_SWEEP_OPTIONS,
  IdempotencyModule,
  PostgresStorage,
  PostgresSweepService,
} from '@nestarc/idempotency';

@Module({
  imports: [
    IdempotencyModule.forRoot({ storage: new PostgresStorage({ pool }) }),
  ],
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
````

- [ ] **Step 2: Add a v0.2.0 entry to the changelog**

Edit `CHANGELOG.md`. At the top of the changelog (before `## [0.1.3]`), add:

```markdown
## [0.2.0] - YYYY-MM-DD

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
```

- [ ] **Step 3: Update the handover doc**

Edit `docs/handover.md`. Search for the section that mentions a future Postgres adapter and either:
- update it to "Implemented in v0.2.0", or
- move the relevant text to a "Roadmap" section and add a "v0.2.0 — PostgreSQL storage adapter" entry under "Shipped".

If `docs/handover.md` does not contain such a section, append a new one:

```markdown
## v0.2.0 — PostgreSQL storage adapter (shipped)

Adds `PostgresStorage` and `PostgresSweepService`. Full design:
[postgres-storage-spec.md](./postgres-storage-spec.md). Implementation
plan: [superpowers/plans/2026-05-02-postgres-storage-adapter.md](./superpowers/plans/2026-05-02-postgres-storage-adapter.md).

Future work tracked for v0.3.0:
- Transactional integration (`@TransactionalIdempotent`) so business
  inserts and idempotency completion share one DB transaction.
- Multi-Postgres-major CI matrix (12, 14, 16, 17).
- Optional JSONB body storage for query-friendly inspection.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md docs/handover.md
git commit -m "docs(postgres): document PostgresStorage usage, migration, and roadmap

README gains a PostgreSQL section with three migration paths and the
opt-in sweep service. CHANGELOG gets a v0.2.0 stub for the upcoming
release. handover.md flips the Postgres item from 'future' to 'shipped'
and lays out the v0.3.0 roadmap (transactional integration, Postgres
matrix, JSONB body)."
```

---

## Task 19: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Unit tests (with Postgres available)**

Ensure Postgres is running (`docker compose up -d postgres`) and `TEST_DATABASE_URL` is set, then:

Run: `npm test`
Expected: full unit suite green, including the new PostgresStorage spec, the lifecycle spec, the sweep service spec, and the regression parity spec.

- [ ] **Step 4: E2E tests**

Run: `npm run test:e2e`
Expected: existing e2e + the new postgres.e2e-spec all green.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exit 0; `dist/` contains `storage/postgres.storage.{js,d.ts}` and `services/postgres-sweep.service.{js,d.ts}`.

- [ ] **Step 6: Pack dry-run — confirm `sql/` is bundled**

Run: `npm pack --dry-run 2>&1 | grep -E "(sql/|postgres)"`
Expected: lines including `sql/init.sql`, `dist/storage/postgres.storage.js`, `dist/services/postgres-sweep.service.js`.

- [ ] **Step 7: Skip-when-unset behavior**

Verify the suite still passes for someone without Docker:

```bash
unset TEST_DATABASE_URL
npm test
```
Expected: skipped Postgres specs print the warning, exit code 0.

- [ ] **Step 8: Final commit (if any uncommitted housekeeping remains)**

```bash
git status
# If clean — done. Otherwise:
git add -p
git commit -m "chore(postgres): final cleanup before v0.2.0 release"
```

---

## Self-Review Notes

This plan was reviewed against [docs/postgres-storage-spec.md](../../postgres-storage-spec.md) section by section:

- §1 v0.2.0 scope (PostgresStorage, sweep, migration options, tests, CI, README) → covered by Tasks 1–18.
- §1 explicit non-goals (transaction integration, ORM-specific adapters, Postgres < 12, multi-major CI) → no task added; v0.3.0 roadmap captured in Task 18.
- §2 LSP precedence → Task 5 plugs into the existing shared contract; Tasks 6–9 implement methods one at a time and are blocked on contract green.
- §3 schema → Task 2 ships the DDL; Task 4 + 11 mirror it in `createSchema()`.
- §4 method SQL → Tasks 6–9 implement each method with the exact SQL from the spec.
- §5 driver / optional peer → Task 1.
- §6 TTL & sweep three layers → Lazy in Task 6, expired-replacement in Task 7, sweep service in Task 12.
- §7 migration three options → Task 4 (`createSchema` + `autoCreateSchema`) and Task 11 (tableName, autoCreateSchema tests), plus the SQL file from Task 2.
- §8 lifecycle → Task 4 (impl), Task 10 (regression test).
- §9 package structure → covered piecewise in Tasks 2, 4, 5, 12, 13, 14, 15.
- §10 testing → contract (Task 5), Postgres-specific (Task 11), sweep (Task 12), e2e (Task 14), regression parity (Task 15).
- §11 CI → Task 16.
- §12 benchmark → Task 17.
- §13 README/CHANGELOG/handover → Task 18.
- §14 phased TDD order → matches Tasks 2–18 ordering.
- §15 risks → mitigations woven into the relevant tasks (e.g. injection defense in Task 4, advisory lock in Task 12, IF NOT EXISTS in Task 11).

**Type/name consistency check:** `pool` and `tableName` are exposed as `/** @internal */ readonly` on `PostgresStorage` (Task 12 step 4) and consumed under those exact names by `PostgresSweepService.sweep()`. `SweepOptions.enabled` is the same in the implementation (Task 12 step 3) and the test (Task 12 step 1). `PostgresStorageOptions` field names (`pool`, `connection`, `poolFactory`, `tableName`, `autoCreateSchema`) are used identically across Tasks 4, 5, 10, 11, and 14.

No placeholders or TBDs remain.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-02-postgres-storage-adapter.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
