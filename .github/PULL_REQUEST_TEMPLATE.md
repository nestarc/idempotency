<!-- Thanks for contributing to @nestarc/idempotency! -->

## Summary

<!-- What does this PR change, and why? Link any related issues. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (adds/removes/changes public API)
- [ ] Documentation only
- [ ] CI / chore

## Correctness / supported profile impact

<!-- Describe any change to replay, fingerprinting, identity/scope, token CAS,
     TTL, failure recovery or observability. Compare HTTP behavior with the
     documented draft-07 profile in README.md, including its differences from
     the draft; this package does not claim full draft or RFC conformance. -->

## Storage contract impact

- [ ] No change to `IdempotencyStorage` / `IdempotencyRecord`
- [ ] Additive change (new optional method/field)
- [ ] Breaking change (new method, renamed field, semantic change)

<!-- For storage contract or adapter behavior changes, update
     `test/support/shared-storage-contract.ts` and verify `MemoryStorage`,
     `RedisStorage` and `PostgresStorage`; update each affected adapter. -->

## Tests

<!-- Check applicable items and record commands/results or explain omissions.
     Documentation and metadata-only changes need only relevant validation. -->

- [ ] Relevant unit / E2E tests added or updated
- [ ] Regression test added under `test/regression/` for a runtime bug fix
- [ ] `npm run lint`, `npm run test:all` and `npm run build` pass
- [ ] Storage checks use real Redis and PostgreSQL with both test service URLs set
- [ ] Package exports / optional peers / declarations verified with `npm run test:consumers`
- [ ] Release candidate passes the shared validation matrix with zero skips/todos and consumers using the same tarball

<!-- Validation evidence and limitations: Default Jest can skip real services
     without TEST_REDIS_URL / TEST_DATABASE_URL. See CONTRIBUTING.md for the
     explicit release gates; a passing default test command is insufficient
     evidence for a release. -->

## Checklist

<!-- Check only the items relevant to this change. -->

- [ ] Updated `CHANGELOG.md` under `[Unreleased]` for user-facing changes
- [ ] Updated public API / configuration / migration documentation as needed
- [ ] Added JSDoc on new public exports
- [ ] For a release, `package.json`, `package-lock.json` and the CHANGELOG release version agree
