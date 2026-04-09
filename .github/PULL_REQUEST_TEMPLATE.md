<!-- Thanks for contributing to @nestarc/idempotency! -->

## Summary

<!-- What does this PR change, and why? Link any related issues. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (adds/removes/changes public API)
- [ ] Documentation only
- [ ] CI / chore

## IETF / correctness impact

<!-- Does this change touch the draft-ietf-httpapi-idempotency-key-header
     behavior? If yes, which section (error codes, replay, fingerprint,
     scope, token CAS, TTL) and how is the new behavior spec-aligned? -->

## Storage contract impact

- [ ] No change to `IdempotencyStorage` / `IdempotencyRecord`
- [ ] Additive change (new optional method/field)
- [ ] Breaking change (new method, renamed field, semantic change)

<!-- If anything in this section is not "No change", the shared contract
     test at `test/support/shared-storage-contract.ts` and both the
     `MemoryStorage` and `RedisStorage` adapters must be updated in the
     same PR. -->

## Tests

- [ ] Unit tests added / updated
- [ ] E2E tests added / updated
- [ ] Regression test added for a bug fix
- [ ] `npm run test:all` passes locally
- [ ] `npm run lint` passes locally
- [ ] `npm run build` passes locally

## Checklist

- [ ] Updated `CHANGELOG.md` (new entry under `[Unreleased]`)
- [ ] Updated `README.md` if public API or options changed
- [ ] Added JSDoc on new public exports
- [ ] Bumped `package.json` version if this PR lands a release
