# Executable payment, order, and webhook recipes

These recipes connect HTTP response replay to application-owned business
deduplication. The executable reference is the
[Express/Fastify fixture](../test/e2e/adoption-recipes.e2e-spec.ts) and its
[PostgreSQL ledger/provider implementation](../test/support/adoption-business.ts).
They use a real PostgreSQL database and a **local provider simulator**. No payment
provider, Stripe API, or external webhook service is called.

The module protects an HTTP storage record. The application separately owns
command identity, authorization, transactions, provider recovery, and retention.
This example introduces no transactional adapter API, retry engine, recovery
endpoint, or exactly-once guarantee.

## Run the recipes

From the repository root, install dependencies and set `TEST_DATABASE_URL` to a
disposable PostgreSQL database whose test user can create schemas. Then run:

```sh
npm ci
S7_REQUIRE_REAL_STORAGE=1 npm run test:e2e -- test/e2e/adoption-recipes.e2e-spec.ts
```

The required flag makes a missing URL fail. Without it, the general test suite
can skip this fixture when no database is configured. Each adapter creates a
random `s7_recipe_*` schema, removes it at teardown, closes its Nest application,
clears MemoryStorage timers, and ends the externally owned Pool. It does not
modify the library's SQL schema or other application tables.

The HTTP tests use the source root export. The independent
[packed consumer fixtures](../test/consumers/README.md) verify published imports,
module wiring, initialization, and shutdown. Applications import common APIs
from `@nestarc/idempotency`, Redis from `@nestarc/idempotency/redis`, and PostgreSQL
from `@nestarc/idempotency/postgres`.

## Payment intent and client command identity

Create a command ID when the user confirms an intent, retain it on the client,
and send it as both the `Idempotency-Key` and the application's `commandId`.
The sample payment body is:

```json
{ "commandId": "pay-20261007-0042", "amount": 1250, "currency": "USD" }
```

A network retry of that intent preserves the command ID, key, and meaningful
parameters. The first completed request returns a serialized receipt; a retry
inside the retained replay window returns the same status and body without
calling the provider again. Amounts in this fixture are integer minor units.
The fixture rejects non-object bodies, non-string/blank command identifiers,
non-string currencies, and malformed order identifiers before any ledger or
provider effects. Real applications also validate allowed currencies, customer ownership,
operation limits, and all domain-specific parameters.

A changed amount with the same scope and HTTP key receives 422. The fixture
also changes only the HTTP key while retaining `commandId`: the durable ledger
still rejects the changed parameters with 422. Investigate whether the client
accidentally changed the body, the command already succeeded, or the user intends
a genuinely new action. A new key is appropriate only for a confirmed new
business command whose authorization and prior outcome are settled. Generating
keys until 422 disappears can cause another charge.

The application command table has `PRIMARY KEY (tenant_id, kind, command_id)`.
It stores the authenticated owner, canonical business parameters, state, and
result. The stored owner must match on every ledger access. The command identity
is tenant-scoped even if another user supplies it; adding a user to the HTTP
scope must not permit a second execution of the same tenant business command.
The separate `kind` differentiates payment and order commands.

The fixture implements this payment flow:

1. In a database transaction, insert a pending command using `ON CONFLICT DO
   NOTHING`, lock/read it, and compare its owner and parameters. Only the
   transaction that inserted the command may start the provider call. Commit
   the pending intent first.
2. Call the simulator with a stable hash of `[tenantId, "payment", commandId]`.
   This provider identity is independent of the HTTP key and replay TTL.
3. Persist the established provider reference and result as succeeded, then
   return the receipt. A later handler exception does not erase that business
   result even though the library may remove its own request lease.
4. For an existing pending command, return an application conflict and hold
   execution for reconciliation. A request retry never starts another provider
   call merely because an HTTP record disappeared.

There is a gap between the provider action and the local result write. In the
lost-acknowledgment test the simulator commits a charge, then throws. An
authorized application reconciliation operation looks up the stable provider
identity, records the established result, and makes the canonical result
available again. This operation is `RecipeLedger.reconcile` in the fixture,
**not** an API supplied by this package. An unknown result, an unreachable
provider, or an empty provider lookup keeps the command pending. Absence alone
does not prove that a former request cannot still commit.

The simulator retains results in memory for the duration of each test and has
an explicit lookup operation. A production provider's deduplication retention,
lookup capabilities, parameter comparison, and recovery guarantees must be
checked independently. The test does not validate those external contracts.
For the complete failure and cancellation rules, use
[failure recovery](failure-recovery.md).

## Authentication, endpoint scope, and serialization

Authentication and current resource authorization must run in Nest guards before
the idempotency interceptor. The fixture's account guard uses a fixed local
credential map; replace that map with the application's verified identity and
authorization logic. Tenant/user request headers are not trusted identities.

Its scope returns the tuple `[user.tenantId, user.userId]`. A functional scope
**adds** this identity to the HTTP method and actual path. Consequently the same
key for another tenant, user, or endpoint cannot replay the first user's payment
receipt. An ownership check in the handler alone is insufficient because replay
can skip the handler. Query strings do not create a new endpoint scope; inspect
the [request isolation contract](../README.md#scope) before relying on query data
for any domain distinction.

The fixture registers interceptors in this order:

```ts
@UseInterceptors(IdempotencyInterceptor, ClassSerializerInterceptor)
```

The outgoing result passes through the serializer before idempotency captures
it. `PaymentReceipt` marks `internalAuditNote` with `@Exclude()`, and both first
response and replay omit the field. The stored response is supported plain JSON.
Controllers use normal Nest return values; this recipe does not use `@Res()`,
streams, SSE, or class instances that bypass serialization. Follow the
[response support contract](../README.md#response-replay-contract) for other
response kinds.

## Orders: transaction and business uniqueness

The order recipe stores a command and an order in one PostgreSQL transaction.
The order table additionally has `PRIMARY KEY (tenant_id, order_id)` and records
the owner, SKU, and quantity. A retry after replay-cache loss returns the existing
order. Even a second command ID for the same order cannot insert another order;
its owner and parameters must match. Changing the quantity for that existing
order is rejected and requires an explicit, separately authorized order-change
workflow with appropriate version checks.

The transaction makes these **local** writes atomic. If placing an order must
also publish a message or call an external service, add an application-owned
outbox and idempotent consumer/provider interaction. Performing that external
action in the SQL transaction does not make the remote action atomic with SQL.

## Webhooks: verify every delivery before replay

The fixture enables Nest's `rawBody: true`. Its guard verifies a timestamped HMAC
over the exact received body, checks recency, validates the signed event, and
binds the request to the configured provider account. Only then does
`keyResolver` read `req.verifiedEvent.id`. The resolver replaces the ordinary
idempotency header; the verified event ID identifies the delivery.

This is a deliberately local **simulator signature protocol**, not Stripe's
signature implementation. A production Stripe guard should call the official
SDK with the unchanged raw bytes, `Stripe-Signature`, and the appropriate
endpoint secret, enforce its recency checks, and authorize the verified account
before storage lookup. Do this for every attempt, including a cached success.
The HTTP test proves that invalid and stale signatures cannot even call
`storage.get` after a valid response has been cached. Never put signature
verification only in the handler.

The application handles three separate concerns in one short SQL transaction:

| Concern | Executable rule | What it does not solve |
| --- | --- | --- |
| Repeated delivery of an event ID | Inbox unique `(account_id, event_id)` plus comparison of the signed event's meaningful fields. | A different event ID describing the same business action. |
| Repeated business action | Fulfillment unique `(account_id, object_id)`. Distinct paid events still produce one fulfillment. | The correct ordering of state changes. |
| Events delivered out of order | Update the projection only when the simulator's resource version is newer. | Providers without a monotonic resource-version contract. |

The example receives a paid version, another paid event with a different event
ID, and an older pending version. All deliveries are acknowledged with 200; one
fulfillment exists and the projection remains paid. A repeated event ID with
changed signed content receives 422 even after replay-cache loss, so the sender
or operator must reconcile it rather than force a new identity.

The `version` field is a contract of **this simulator**. Do not substitute
Stripe's `event.created` as a version: Stripe does not guarantee event order and
events can share a timestamp. Use authoritative resource retrieval or a
domain-specific state transition policy when the provider lacks a suitable
version. For longer processing, commit a durable inbox/outbox handoff before
acknowledging, and have a worker perform business deduplication. Returning 2xx
before durable acceptance can lose work.

## Retention and provider redelivery

Stripe's official [event delivery policy](https://docs.stripe.com/webhooks#event-delivery-behaviors)
was checked on **2026-10-07**: live-mode automatic retries can continue for three
days; Dashboard resends are available for 15 days and CLI resends for 30 days
after event creation. A successful manual resend does not cancel outstanding
automatic retries. Delivery order is not guaranteed. Keep event-delivery IDs
distinct from business-object deduplication.

Choose retention separately for each record type:

| Record | Sample policy and reasoning |
| --- | --- |
| PROCESSING lease (`processingTtl`) | The runnable fixture uses 60 seconds for its bounded local operation. Choose an actual execution window, including dependency delays; expiry does not cancel an older worker. There is no heartbeat. |
| HTTP replay response (`ttl`) | The fixture uses 86,400 seconds. It optimizes repeated responses; it does not define the period in which the business action is safe to repeat. |
| Durable webhook inbox | If the service accepts the 30-day resend window, an example policy is at least 35 days from receipt, plus any longer internal replay/backfill horizon. The extra five days are an application margin, not a provider guarantee. |
| Commands, orders, and business uniqueness | Retain identity/results or an adequate deduplication tombstone for the whole period in which that business action can be redelivered or reconstructed. This can exceed inbox and response retention. Pending/unknown commands must not be purged to enable retry. |

The fixture does not implement a retention worker; its database rows remain
until explicit test cleanup. A production service must implement and validate
its own cleanup and replay policy. Data retention constraints may require
keeping a minimal tombstone instead of the original payload. After a tombstone
is removed, the service must reject old identities or accept that its duplicate
protection has ended.

Do not set a universal 30-day HTTP TTL merely because a provider permits a
30-day resend. A shorter cache can be safe when the durable inbox and business
constraints still protect re-entry. Conversely, a 30-day cache alone cannot
protect an older business duplicate. `ttl` and `processingTtl` accept integer
seconds from 1 through 2,147,483,647; invalid configuration is a server error,
not a client 400.

## Verification and limits

On 2026-10-07 the dedicated command above passed **22 tests, 0 skipped**, using
PostgreSQL 16 on the S7 local test service and both Express and Fastify. TypeScript
compilation also passed. The cases cover runtime input validation, receipt serialization/replay, changed
payloads, tenant/user/endpoint isolation, post-commit handler failure, provider
acknowledgment loss and reconciliation, unknown outcomes, order uniqueness, and
webhook signature/event/business/order boundaries.

Cache-loss tests clear the fixture's MemoryStorage to model loss of cached
records while retaining the PostgreSQL business ledger. They do not kill an
application process or delete production locks. Provider failures are explicit
simulator injections. These checks establish application control flow and local
SQL constraints; they do not establish provider recovery, database failover
durability, process-crash safety at every boundary, or a production retention
worker. The [S5 real crash experiments](failure-recovery.md#reproduce-and-assess-the-evidence)
cover separate worker-crash scenarios. Release-wide evidence belongs to
[the S7 work item](1.0.0/work-items/S7-adoption-docs.md).
