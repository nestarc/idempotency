# Selected mutation probes

This runner demonstrates whether existing tests reject seven deliberately chosen
defects. It is a small, repeatable check of test sensitivity, not a mutation
coverage score or proof that the package has no other defects.

Install the repository dependencies and start dedicated PostgreSQL and Redis test
services. Configure `TEST_DATABASE_URL` and `TEST_REDIS_URL`, then run:

```sh
node test/mutation/run.mjs --output /private/tmp/idempotency-mutation-evidence
```

Choose a new output directory outside the repository; its parent must exist. The
runner refuses to overwrite previous evidence. Both service URLs are required;
optional-storage skips cannot count as validation. `--timeout-ms N` optionally
lowers the 60-second deadline for each Jest process. A Jest test-level timeout is
also an error, never evidence that a mutant was caught.

## Defects and independent observations

| Probe                            | Injected defect                                                                     | Existing test observation                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-stale-owner`             | A nonempty stale token can complete a Memory record.                                | Shared storage contract and Memory race checks reject the old owner and preserve the replacement record.                                  |
| `postgres-stale-owner`           | The completion SQL no longer compares the owner token. The UUID bind remains valid. | The real PostgreSQL contract rejects a different valid UUID, including another record's owner, without changing the record.               |
| `redis-stale-snapshot`           | The Lua completion script no longer checks its previously read processing payload.  | Two real Redis clients pause a read, complete the lease from the other client, then prove the stale snapshot cannot overwrite the winner. |
| `fingerprint-mismatch-bypass`    | The interceptor ignores a different fingerprint on an existing key.                 | Interceptor tests require the mismatch response and prevent another handler execution.                                                    |
| `handler-ttl-ignored`            | Route metadata no longer overrides the module TTL.                                  | The HTTP test advances the clock to the route's expiry while the default route still replays.                                             |
| `intermediate-response-capture`  | `takeLast(1)` and its now-unused import are removed.                                | Controlled multi-emission tests keep intermediate values private and persist only the final successfully completed response.              |
| `persisted-replay-version-drift` | Both encoder and decoder change their prefix from replay v1 to v2.                  | Literal persisted v1 fixtures catch protocol drift even when encode/decode round trips still succeed together.                            |

The Redis probe removes the processing-payload compare-and-set guard, not merely
the token check. Removing only its Lua token check can leave public behavior
protected by the earlier token check and the independent payload comparison.

## Evidence and classification

The runner copies the current source, tests, benchmark helpers, scripts, SQL,
package metadata, configuration, and documentation into a new temporary snapshot.
Only `node_modules` is linked to the existing install. Source symlinks are rejected;
original repository source files are never edited. Each patch anchor must appear
exactly once; changed source produces a drift error instead of silently testing a
different change. Original source hashes are checked again when the run finishes.

The complete set of selected suites first runs against the unchanged snapshot.
All must pass with zero skips or todos before any mutation is applied. Each defect
then runs alone against its listed suite, with the snapshot restored between runs
and Jest transform caching disabled. Results are classified conservatively:

- **killed**: Jest exits 1 and every reported failed test contains a recognized
  matcher assertion failure. Full test names and failure messages are retained.
- **survived**: The selected suite still passes after the defect is introduced.
- **error**: Baseline failure, skipped tests, missing results, anchor drift,
  compilation/import/runtime failure, timeout, interruption, or an unrecognized
  failure. An error does not count as a kill.

`summary.json` records the baseline, exact patches, per-probe classifications,
failed assertion names/messages, source snapshot digest, and original-source
integrity check. `snapshot-files.json`, each `*.jest.json`, and each `*.log`
retain the supporting evidence. The isolated snapshot is also kept for inspection.
Service URLs and passwords are redacted from written results; no environment dump
is recorded. Any survivor or error makes the command exit 1. Only seven kills
after a valid baseline produce exit 0.

Results apply only to these selected defects, the current test snapshot, installed
dependencies, and configured services. They do not measure performance, explore
all possible races, cover every branch, or replace the full test and release
matrix. A hard timeout may prevent test cleanup; use disposable services for these
intentionally broken implementations.
