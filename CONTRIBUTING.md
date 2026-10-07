# Contributing to `@nestarc/idempotency`

Thanks for wanting to help! This is a small, focused library that takes
correctness very seriously. Please read this page before your first PR.

## Prerequisites

- Node.js 22 or 24 (the `engines` field in `package.json`).
- npm 10 or 11 (the bundled version for Node22/24); publishing uses Node24/npm11 and npm Trusted Publishing.
- PostgreSQL 16 and Redis 7 for real-adapter, adoption and failure-lifecycle
  verification. Some unit tests use mocks/Memory, but they do not replace these
  service checks. Use test-only databases: fixtures create/truncate/drop tables
  and dedicated keys. Never point the tests at production.

## Local workflow

```bash
npm ci                   # clean install from package-lock.json
npm run lint             # eslint
npm run test             # unit tests only
npm run test:e2e         # in-process NestJS app e2e
npm run test:all         # both
npm run test:cov         # unit project coverage report (threshold 80%)
npm run build            # tsc → dist/
npm run prepublishOnly   # clean + lint + test:all + build
```

Before merging, run the checks above with both service URLs. Missing URLs can
silently skip real-service suites in the default Jest command. To run the S7
adoption gate (missing either URL is an error):

```sh
export TEST_DATABASE_URL=postgresql://test:test@localhost:5432/idempotency_test
export TEST_REDIS_URL=redis://localhost:6379
npm run test:adoption
```

`docker compose up -d --wait` starts PostgreSQL 16 and Redis 7 with health checks. The adoption command covers wiring, recipes and
migration, then builds and installs the actual tarball for public-import examples.
See [S7](docs/1.0.0/work-items/S7-adoption-docs.md) for evidence and limitations.

CI and release use the same reusable validation workflow: Node22/24 × Nest10/11
× minimum/representative optional peers. Every cell runs the complete source suite
and actual-tarball consumers with both PostgreSQL 16 and Redis 7. Express and
Fastify are exercised within each cell. Missing services, skips/todos, missing
required specs, reduced assertion counts, consumer failures and artifact mismatch
fail the gate. Exact versions live in `scripts/release-matrix.mjs`.
See [S8](docs/1.0.0/work-items/S8-release-validation.md) for recorded evidence.

### Isolated package consumers

For package exports, optional peers or public declarations, also run
`npm run test:consumers` with test-only `TEST_DATABASE_URL` and `TEST_REDIS_URL`.
This builds and installs an actual tarball outside the repository, runs strict
TypeScript checks, and boots Nest against Memory/Redis/Postgres. Use
`npm run test:consumers -- --tarball /absolute/path/package.tgz` to reuse a
specific artifact. The runner preserves generated lockfiles, installed trees,
logs and a checksum. See [consumer fixtures](test/consumers/README.md).

`--skip-services` is available for partial local checks and records explicit
skips; it is insufficient for S2/S7/S8 completion and the release gate rejects it.

### Failure lifecycle experiments

Set test-only `TEST_REDIS_URL` and `TEST_DATABASE_URL`, then run
`npm run test:failure:real`. Both are mandatory for this command. The fixture
uses real child-process SIGKILL, IPC gates, isolated storage namespaces and a
PostgreSQL business ledger. Set `S5_EVIDENCE_PATH` to retain JSON observations.
See [failure recovery](docs/failure-recovery.md) and [S5 evidence](docs/1.0.0/work-items/S5-failure-lifecycle.md)
for the distinction between real worker crashes, application-boundary rejection,
and untested network/server failure modes.

### Benchmark diagnostics

Run `npm run bench:smoke` with both test-only service URLs to check the benchmark
on Express/Fastify and Memory/Redis/Postgres. For timing samples, options, isolated
storage cleanup and interpretation limits, see [bench/README.md](bench/README.md).
The benchmark validates every response and fails on configured service or cleanup
errors. Its latency measurements do not replace the package release gate.

## Changing the `IdempotencyStorage` contract

If your PR modifies `src/interfaces/idempotency-storage.interface.ts`,
`src/interfaces/idempotency-record.interface.ts`, or any adapter, you
must also update the **shared storage contract test suite** at
`test/support/shared-storage-contract.ts`. Every adapter (built-in or
custom) runs against this suite — any behavioral drift is caught as a
shared failure, not a per-adapter regression.

All built-in adapters (`MemoryStorage`, `RedisStorage`, `PostgresStorage`) plug into
the suite in their respective spec files. Each harness must provide an expiry
control that does not call get/delete to clean the expired record first:

```ts
describeStorageContract('MemoryStorage', async () => {
  const storage = new MemoryStorage();
  return {
    storage,
    expire: async (key) => {
      const record = await storage.get(key);
      if (!record) throw new Error('Expected a live test record');
      record.expiresAt = new Date(Date.now());
    },
    cleanup: async () => { await storage.onModuleDestroy(); },
  };
});
```

## Writing regression tests

Any bug fix must land alongside a regression test under
`test/regression/`. The test must:

1. Reproduce the pre-fix behavior (fail on the old code).
2. Pin the post-fix behavior (pass on the new code).
3. Carry a JSDoc block explaining the bug and the fix at the top of the
   spec file. Future readers need to know WHY the test exists.

See `test/regression/complete-failure-cascade.spec.ts` as a reference.

## Release process

Releases are driven by git tags that match `v*.*.*` and fire the
`release.yml` workflow automatically. Steps:

1. **Finalize the CHANGELOG.** Move the `[Unreleased]` section to a new
   `[X.Y.Z] — YYYY-MM-DD` heading. Describe the changes under the
   standard Keep-a-Changelog sub-headings (`Added`, `Changed`, `Fixed`,
   `Removed`, `Security`).
2. **Bump `package.json`.** Match the version used in the CHANGELOG
   heading exactly. The release workflow verifies this.
3. **Commit** with a message like `chore: release v0.1.4`.
4. **Tag** the commit: `git tag v0.1.4 && git push origin v0.1.4`.
5. **Push** main + the tag. The `release.yml` workflow will:
   - Verify the tag matches `package.json`.
   - Build and pack once, then validate that artifact in all eight cells.
   - Preserve the SHA-256, commit, test JSON, consumer lockfiles and logs.
   - Verify the complete matrix and download the validated artifact for publication.
   - Publish that exact tarball with `--ignore-scripts --provenance --access public`.
   - Create a GitHub Release with the CHANGELOG excerpt.

### Publishing authentication and current limits

The workflow uses npm Trusted Publishing (OIDC), with GitHub environment `npm`
and `id-token: write`; it does not read an `NPM_TOKEN` secret. Configure the npm
trusted publisher for repository `nestarc/idempotency`, workflow `release.yml`,
and environment `npm`. The publish job selects Node24. Review the actual
[release workflow](.github/workflows/release.yml) before changing authentication.

The publish job does not install dependencies, rebuild, repack, or rerun lifecycle
scripts. It checks the downloaded artifact's commit/version/checksum and all eight
validation records before passing its explicit `.tgz` path to npm. Missing or
changed artifacts fail closed. Registry configuration and publication remain
separate release actions; running local validation never publishes anything.

### Validation without publishing

**Actions → Release → Run workflow** runs validation only. Manual dispatch cannot
publish; publication is restricted to the matching tag-push path. CI invokes the
same reusable workflow, so its service setup and validation commands match release.

For a local candidate (both test-only service URLs must be set):

```sh
npm ci
npm run test:release-gates
npm run release:build -- --output /tmp/idempotency-candidate
node scripts/release-matrix.mjs install --nest 11 --peer-profile representative
npm run release:validate -- --artifact /tmp/idempotency-candidate/artifact.json \
  --output /tmp/idempotency-validation-node24-nest11-representative \
  --nest 11 --peer-profile representative
```

The build requires a clean checkout; `--allow-dirty` is an explicit local diagnostic
option and its provenance cannot be promoted as a clean release candidate. Output
directories must be fresh. Consumer installs remain outside the checkout. Use the
matrix installer to select root dependencies before each validation and use the
matching Node runtime; changing only a label does not validate a different version.
Repeat for every declared cell, then run `npm run release:matrix -- --artifact
/tmp/idempotency-candidate/artifact.json --evidence /tmp/idempotency-validation` with
the cell output directories below that evidence directory. CI retains the artifacts
for 14 days; save an approved candidate's evidence elsewhere before it expires.

Default Jest and `prepublishOnly` remain useful development commands but can skip
real services without URLs. Only the explicit release validation gate enforces the
required service, test, consumer and artifact evidence.

## Style

- **Commit messages**: imperative voice, present tense. Prefixes
  (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`) are welcome but
  not enforced.
- **Code**: strict TypeScript. `any` is discouraged — prefer precise
  types or `unknown` + narrowing.
- **Comments**: explain *why*, not *what*. The code already says what
  it does.

## Security issues

Please do **not** open a public issue for a vulnerability that could
allow duplicate execution, key leakage, or other correctness problems.
Email the maintainer directly (see the `author` field in
`package.json`) or use GitHub's private vulnerability reporting.

Thanks!
