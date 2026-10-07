# Failure lifecycle and recovery

This guide describes the unreleased 1.0 failure contract. Idempotency records
coordinate HTTP attempts and retain replayable results for a limited time.
They do not commit atomically with a business database or external provider.
A timeout, missing record, expired lease or failed storage acknowledgment does
not establish whether the business operation happened.

Use a durable business command ID, scoped to the authenticated tenant or other
business owner, to prevent repeated side effects across retries, restarts and
storage migrations. Keep this protection for the application's actual
redelivery window, which may exceed both idempotency TTLs.

## Failure transitions

The table assumes an acquired request with the same scope, key and fingerprint
on retry. A different fingerprint can produce 422 before the state checks.
Storage exceptions below include both synchronous throws and rejected Promises.
The application and HTTP adapter determine the HTTP response for propagated
errors; the library does not turn every storage error into a retryable status.

| Phase | Business outcome | Storage state and library action | Client and observation | Retry condition |
| --- | --- | --- | --- | --- |
| Initial `get` fails | This attempt has not run the handler. | No write by this attempt; another attempt's state is unknown. | Original error; one `storage_error` for `get`. | Restore storage access and inspect the existing attempt; this failure says nothing about earlier attempts. |
| `create` fails | This attempt has not run the handler. | A failed acknowledgment may follow a successful PROCESSING write. No cleanup without an acquired token. | Original error; one `storage_error` for `create`. | Re-read after storage is available. A retained lease blocks another attempt; absence alone does not establish the outcome of other attempts. |
| Lost create race, `race_get` fails | This attempt has not run the handler; the winner may have run it. | No mutation by the losing attempt. | Original error; one `storage_error` for `race_get`. | Inspect the winner. A successful re-read normally replays COMPLETED or returns 409 for PROCESSING; a vanished race record also returns 409 for this attempt. |
| Handler errors, including an inner timeout | Failure may precede or follow a business side effect. | Best-effort `delete(key, token)`; only the owned record may be removed. Intermediate values are not captured. | Original handler error after cleanup settles. Handler error and successful cleanup add no event. | The library permits a new execution after deletion. The application must establish that retry is safe or deduplicate the business command durably. |
| Response capture fails or is unsupported | Handler completed successfully; its returned value may still fail later HTTP serialization. | No completion write or cleanup; retain PROCESSING until expiry. | Pass through the original value; one `bypassed` with `response_not_replayable`. | Matching retries receive 409 during the lease. Reconcile business results before any execution after expiry. |
| `complete` throws or rejects | Handler completed successfully. | Never invoke handler-error cleanup. PROCESSING usually remains; an applied write with a lost acknowledgment may already be COMPLETED. | Pass through the successful value; one `complete_error` for `complete`. | Inspect storage and the business result. PROCESSING yields 409; valid COMPLETED can replay. Expiry does not authorize repeated side effects. |
| `complete` returns `stale` | Handler completed successfully. | No mutation: record is absent, expired, already completed, or owned by another token. | Pass through the successful value; one `stale`. | Preserve the current owner's record. Reconcile the business command before another execution. |
| Handler cleanup `delete` throws or rejects | Original handler failed; business effects may already exist. | No second cleanup. Record may remain or deletion may have committed before the acknowledgment failed. | Preserve the original handler error; one `storage_error` for `delete`. | Inspect storage and the business outcome. Cleanup failure is not evidence of rollback. |
| External unsubscribe/outer timeout | Later success, failure or continued uncertainty are all possible. | Tear down the subscribed source. Do not initiate completion or deletion for a later handler outcome. An already-started storage Promise may still apply its write. | No further result, outcome event or status update through the canceled subscription. Outer code may produce its own timeout response. | Inspect the business command and any surviving record. Do not treat cancellation as proof of business cancellation. |
| Worker/process crash | Depends on the last committed business action. | No reliable cleanup. Memory records disappear; shared storage may retain PROCESSING or COMPLETED according to the last applied write and database durability. | Response and events may be missing even when the operation committed. | Reconcile before retrying, including after the lease expires. See the crash cases below. |

Event counts describe failures observed by an active subscription with `onEvent`
configured. A cancellation before a pending Promise settles prevents its
completion/error event from being delivered; it does not reverse the Promise's
side effects. Events are best-effort diagnostics, not an audit ledger. Error
payloads use fixed codes and operations; they do not contain the original error.
Status headers are optional and can only be written while the response allows it.

## Timeout placement and cancellation

An **outer timeout** subscribes to the idempotency result and then stops that
subscription, for example conceptually `idempotencyResult$.pipe(timeout(...))`.
It closes the handler's RxJS subscription, with no detached background
subscription to finish recording the result. An Observable can stop work in its
teardown; an already-started Promise, database transaction or provider request
may continue independently. A later handler success or rejection does not
trigger `complete` or `delete` after unsubscribe.

An **inner timeout** is part of the Observable returned by `next.handle()` to
idempotency. Its error is a handler error and follows best-effort token deletion.
If the underlying operation continues despite that timeout, a retry can overlap
it after cleanup. The same rule applies to any exception thrown after a business
transaction commits. The library cannot distinguish these cases from failures
before any side effect; durable application deduplication is required.

If cancellation occurs during `create`, its Promise may still create a lease,
but the canceled attempt will not subsequently start its handler. If it occurs
during `complete`, the write may still become COMPLETED without a `created`
event or a delivered response. If it occurs during handler-error `delete`, the
delete may still remove the record without delivering the original error or a
cleanup-failure event. There is no compensating cleanup after cancellation.

Nest interceptor ordering determines whether a timeout surrounds or is inside
idempotency. Check the actual returned Observable chain in your application.
A client disconnect is not itself proof that Nest unsubscribed this chain;
this contract applies when unsubscribe actually occurs. The package does not
add transport disconnect handling or an AbortSignal for business operations.

## Leases and stale ownership

The default `processingTtl` equals `ttl` (86,400 seconds unless configured).
Choose a processing lease that covers the execution window you intend to
protect, including dependency delays and pauses. A percentile is not a maximum:
an operation can outlive any finite lease. There is no automatic heartbeat.

The minimum storage contract used by this lifecycle is:

- A lease is logically absent at its storage deadline even if physical cleanup
  has not run. Memory/Postgres use `expiresAt <= now`; Redis uses its server TTL.
  Redis payload `expiresAt` is client-clock metadata, not a synchronized server deadline.
- `complete` may change only an unexpired PROCESSING record with the same token.
  Missing, expired, replaced and already-COMPLETED records return `stale`.
- Repeating `complete` leaves the stored response, expiry and `createdAt`
  unchanged. A successful first completion refreshes the replay TTL and preserves
  the original `createdAt`.
- An old token cannot complete or delete a live replacement record. Deleting a
  logically absent record returns `ok`; it grants no ownership of a new record.

After lease expiry, a new attempt can acquire a new token and run the handler
while the original business operation is still running. Token checks protect
the new idempotency record from the old writer; they cannot undo or prevent
business side effects from that old worker. `stale` is a storage ownership result,
not confirmation that business work failed.

These rules also apply to custom adapters. Full TTL range and cross-adapter
adapter verification is recorded in [S6](1.0.0/work-items/S6-storage-contract.md);
final release validation remains [S8](1.0.0/work-items/S8-release-validation.md).

## Crash boundaries

| Crash point | Possible surviving shared record | Business evidence needed |
| --- | --- | --- |
| Before acquisition | Absent, or a different attempt's record | Confirm whether any earlier attempt exists for this business command. |
| After acquisition, before business execution | PROCESSING until lease expiry | Establish that no worker/provider began the command; missing events alone do not prove this. |
| After business commit, before completion write | PROCESSING until lease expiry | Durable command result or provider transaction proves success even though HTTP replay is unavailable. |
| While completion is in flight | PROCESSING or COMPLETED | Query storage and the business ledger; a missing acknowledgment leaves the write uncertain. |
| After completion, before the client receives the response | COMPLETED if the database retained the write | Valid stored response can replay while retained; keep business deduplication for later retries. |

MemoryStorage loses every record on restart. Redis/Postgres survive application
worker restarts only to the extent provided by their own persistence,
replication and failure configuration. Idempotency storage and a business ledger
can disagree because they are separate writes, even if they use the same database.

## Reconcile a payment command

Suppose a caller submits command `pay-20261007-0042` for tenant `tenant-42`.
The application creates a durable command entry protected by a unique
`(tenant_id, command_id)` constraint and checks that repeated commands carry the
same business parameters. It uses that identity for provider deduplication where
the provider supports it, and stores the provider reference and established
result. This is application logic; the module does not create this ledger.

After a timeout or crash, pause automatic redelivery for that command and use
an authorized application support workflow to inspect its ledger entry:

```sql
-- Example application-owned schema, not the idempotency adapter's schema.
SELECT state, provider_reference, result, updated_at
FROM payment_commands
WHERE tenant_id = 'tenant-42'
  AND command_id = 'pay-20261007-0042';
```

Query the provider by its stable command identity or recorded transaction
reference as well. A missing local result can mean the provider committed
before the local transaction completed. Apply the following decisions:

| Evidence | Application action |
| --- | --- |
| Business/provider success is established | Persist or confirm the canonical ledger result and return it through the application's authenticated result/reconciliation workflow. Do not charge again just to recreate a cache entry. |
| Failure is definitive, no side effect occurred, and no worker/provider request can still commit | The application may retry the same business command with its durable deduplication in place. Ordinary HTTP retry still observes any active idempotency lease. |
| Provider is pending/unreachable, local and provider results disagree, or a former worker could still commit | Keep the command pending for operator/provider reconciliation and hold automatic retries, even after the idempotency TTL expires. |

Neither an absent ledger row nor an absent idempotency record alone proves that
the provider did nothing. A local unique constraint alone also cannot make an
external provider call atomic with the local database. The application must
design the provider interaction, result recording and recovery for that gap.

When an authorized operator also inspects idempotency storage, retain the
record's status, token, fingerprint, `createdAt` and `expiresAt` as supporting
evidence. `IdempotencyStorage.get(storageKey)` reads a known storage address; the
package does not expose a raw-header-to-storage-key lookup helper or a public
recovery endpoint. Obtain the address through restricted application-owned
adapter instrumentation or an authorized storage investigation that can map it
to the command. Do not guess it from the raw header. The hashed storage address
is distinct from the event's `keyHash`, which hashes that address again;
`namespace` identifies a hashed scope, not a raw tenant or an adapter key prefix.
These event fields cannot be inverted into a reliable storage lookup.

Keep support evidence in access-controlled systems rather than adding raw keys,
tokens, payment bodies or provider errors to metric labels and public events.
A storage observation is only a snapshot; recheck the durable business state
before deciding whether execution is allowed.

The library provides no generic retry, force-unlock, automatic reconciliation,
lease renewal or exactly-once transaction mechanism. Resolve uncertainty in the
business workflow without deleting records to bypass 409 or changing keys to
force execution.

## Reproduce and assess the evidence

The repository keeps deterministic
[failure/cancellation tests](../test/regression/failure-lifecycle.spec.ts),
[capture failure tests](../test/regression/response-capture-failure.spec.ts) and
[lease boundary tests](../test/regression/storage-lifecycle-contract.spec.ts).
The [real failure fixture](../test/regression/failure-lifecycle.real.spec.ts)
starts a [child worker](../test/support/failure-lifecycle-child.ts) with
[shared fixture support](../test/support/failure-lifecycle-real.ts), kills it
at IPC barriers and restarts requests against real Redis/Postgres. Both adapters
use a separate PostgreSQL business-ledger transaction for this experiment.

Run the dedicated real-service command with both `TEST_REDIS_URL` and
`TEST_DATABASE_URL` set to disposable test services:

```sh
npm run test:failure:real
```

It fails if either URL is missing. The general Jest suite can skip these tests
when services are unavailable, so a green general run alone is insufficient.
Set `S5_EVIDENCE_PATH` to a writable JSON path to retain scenario evidence.

The experiments record handler count, business ledger, token/state and the
interceptor's client result. They cover crashes before business commit, after
business commit and after completion, plus completion rejection before and after
an applied write. They first check a retry before expiry, then shorten server
expiry in the isolated test namespace and observe retry after expiration.
That test-only mutation is not an operator recovery procedure.

The crash is an actual process `SIGKILL`, but the client result is inspected at
the interceptor boundary without a TCP HTTP server. Completion failures are
injected before the adapter call or after its successful reply, not by disrupting
the database network. These tests do not establish provider recovery, database
failover durability or behavior at every production transport boundary. See
[S5](1.0.0/work-items/S5-failure-lifecycle.md) for executed commands, environment,
pass/skip counts and retained evidence; this guide itself is not a test report.
