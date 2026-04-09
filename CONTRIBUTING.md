# Contributing to `@nestarc/idempotency`

Thanks for wanting to help! This is a small, focused library that takes
correctness very seriously. Please read this page before your first PR.

## Prerequisites

- Node.js ≥ 20 (the `engines` field in `package.json`).
- npm ≥ 9 (for `npm pkg get`, provenance, and workspaces support).
- A real Redis is **not** required — unit tests use `ioredis-mock` and
  e2e tests use `MemoryStorage`. If you want to run against a real Redis
  locally, point `RedisStorage` at your instance manually.

## Local workflow

```bash
npm ci                   # clean install from package-lock.json
npm run lint             # eslint + prettier
npm run test             # unit tests only
npm run test:e2e         # in-process NestJS app e2e
npm run test:all         # both
npm run test:cov         # unit + coverage report (threshold 80%)
npm run build            # tsc → dist/
npm run prepublishOnly   # clean + lint + test:all + build (the full CI chain)
```

Every PR must pass the `prepublishOnly` chain before it merges; CI
enforces this automatically.

## Changing the `IdempotencyStorage` contract

If your PR modifies `src/interfaces/idempotency-storage.interface.ts`,
`src/interfaces/idempotency-record.interface.ts`, or any adapter, you
must also update the **shared storage contract test suite** at
`test/support/shared-storage-contract.ts`. Every adapter (built-in or
custom) runs against this suite — any behavioral drift is caught as a
shared failure, not a per-adapter regression.

Both built-in adapters (`MemoryStorage`, `RedisStorage`) plug into the
suite at the top of their respective spec files:

```ts
describeStorageContract('MemoryStorage', async () => {
  const storage = new MemoryStorage();
  return {
    storage,
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
   - Run the full `prepublishOnly` chain on a clean runner.
   - Publish to npm with `--provenance --access public`.
   - Create a GitHub Release with the CHANGELOG excerpt.

### Required secrets

The release workflow needs one repository secret:

- `NPM_TOKEN` — an **Automation** token created at
  https://www.npmjs.com/settings/nestarc/tokens/granular-access-tokens
  with publish rights on `@nestarc/*`. Add it under
  `Settings → Secrets and variables → Actions → New repository secret`.

OIDC provenance does not require a secret — GitHub's runtime id token
is used automatically via the `id-token: write` permission.

### Manual / emergency publish

If the tag path has a hiccup, you can dispatch the release workflow
from the Actions tab:

1. Go to **Actions → Release → Run workflow**.
2. Pick the `main` branch.
3. Set `dry_run: true` first to verify the pipeline, then re-run with
   `dry_run: false` to actually publish.
4. The GitHub Release step is skipped on manual dispatch — create the
   release manually in that case.

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
