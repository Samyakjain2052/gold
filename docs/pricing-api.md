# Pricing API and Audit Trail

Stage 7. The shopkeeper-facing pricing configuration API and its audit trail.

Composes the existing infrastructure rather than reimplementing any of it —
identity from [authentication.md](authentication.md), isolation from
[tenant-isolation.md](tenant-isolation.md), arithmetic from
[ADR-0003](adr/0003-integer-paise-per-gram.md) and
[ADR-0005](adr/0005-rounding-and-breakdown-display-policy.md).

---

## 1. Endpoints

All under `/api/v1`. Every route sits behind the Stage 5 `authenticate`
middleware, applied **at mount** so a new route cannot be added without it.

| Method | Path | Capability | Success |
|---|---|---|---|
| `GET` | `/pricing-rules` | `tenant:pricing:read` | `200` `{data, meta:{count}}` |
| `GET` | `/pricing-rules/:id` | `tenant:pricing:read` | `200` `{data}` + `ETag` |
| `POST` | `/pricing-rules` | `tenant:pricing:write` | `201` `{data, meta:{replayed}}` |
| `PATCH` | `/pricing-rules/:id` | `tenant:pricing:write` | `200` `{data, meta:{replayed}}` |
| `DELETE` | `/pricing-rules/:id` | `tenant:pricing:delete` (owner) | `200` — soft delete |
| `GET` | `/audit-logs` | `tenant:audit:read` (manager+) | `200` `{data, meta:{next_cursor}}` |

There is deliberately **no write route for audit logs**. A route that could
append would let a caller author history; one that could amend would let a
caller rewrite it.

### Request shape

```jsonc
// POST /api/v1/pricing-rules
{
  "product_id": "9f381372-…",
  "adjustment_kind": "absolute",          // or "percentage"
  "adjustment_rupees_per_gram": "50.00",  // absolute only, STRING
  "rounding_step_paise": 100,
  "rounding_mode": "half_up",
  "component_precision_paise": 1
}
```

**Money is a decimal string, never a JSON number.** `{"adjustment": 50.07}` is
an IEEE-754 double by the time it is parsed, and the whole pricing architecture
exists to keep floats out of money.

A discriminated union on `adjustment_kind`: an absolute rule carries an amount,
a percentage rule carries basis points, and **neither may carry the other**.
Accepting both would make "which applies?" ambiguous and invite a later reader
to derive one from the other.

### Response shape

DTOs, never Prisma models. `tenant_id`, `created_by`, `updated_by` and
`adjustment_value` are not exposed: a client has no use for them, and publishing
storage columns makes every future migration a breaking API change.

---

## 2. Authorization

Unchanged from Stage 5 — this stage adds no new mechanism.

```
verified identity → derived context → require_capability → tenant service → RLS
```

Handlers call `require_tenant_actor(auth_context_of(req))`. A **platform admin
is refused**, exactly as the Stage 5 matrix specifies: an admin is not a
super-shopkeeper, and letting an admin context satisfy a tenant check would make
every tenant guard conditional on a role string.

`AuthorizationError` is mapped to `403` in the error renderer. An authorization
decision must never surface as a `500`.

### Status codes

| Situation | Status |
|---|---|
| Unparseable body | `400` |
| Valid JSON failing validation, or an **unknown field** | `422` |
| No or invalid token | `401` |
| Lacking capability, **or another tenant's rule** | `403` |
| Missing `If-Match` on a conditional write | `428` |
| Stale version · duplicate active rule · idempotency-key reuse | `409` |

A cross-tenant rule returns the **same** `403` as a nonexistent one — same
status, code and message — so the response cannot be used to discover which ids
exist. Asserted by `PricingApi_foreignAndUnknownIds_produceIdenticalResponses`.

`428 Precondition Required` is the one status outside the brief's list. It is
the correct answer to "you must quote a version and did not"; folding it into
`409` would tell a client their write conflicted when they never declared what
they were overwriting.

---

## 3. Concurrency

`tenant_pricing_rules.version` (new, additive). Writes are conditional:

```sql
UPDATE tenant_pricing_rules
   SET …, version = version + 1
 WHERE id = $1 AND tenant_id = $2 AND version = $3
```

Zero rows matched means someone else moved first → `409`. `updateMany` is used
rather than `update` because `update` matches on the primary key alone and would
reach another tenant's row before RLS rejected it.

Clients read the version from `ETag` (or the body) and quote it in `If-Match`.
Both `5` and `"5"` are accepted.

**Why required rather than optional:** an optional precondition is one a client
forgets under load, which is exactly when concurrent edits happen. Requiring it
makes the lost update unreachable rather than merely unlikely.
`PricingApi_simultaneousUpdates_onlyOneSucceeds` fires two real concurrent
requests and asserts `[200, 409]` with exactly one audit row.

### Concurrent creates

Only one **active** rule may exist per product, enforced by the partial unique
index `uq_tenant_pricing_rules_active`. A read-then-insert pre-check catches the
ordinary case, but two simultaneous creates can both pass it and only the second
insert fails — so the database constraint, not the pre-check, is the guarantee.

Both paths now produce the **same** `409` with the same message
(`An active pricing rule already exists for this product`). Previously the
constraint path escaped as a `500`: a client's correct retry logic would have
seen an unrelated-looking server error for a perfectly ordinary race.

The mapping is scoped to that one constraint by name, via
`src/platform/prisma_errors.ts`. Prisma reports every unique violation as
`P2002`, so matching on the code alone would dress an unrelated conflict up as a
duplicate pricing rule and hide a real bug. The constraint name is read from the
driver-adapter error shape (`meta.driverAdapterError.cause.constraint.index`),
with the classic `meta.target` shape handled as a fallback; anything
unrecognised returns `null` and the original error propagates as a `500`, which
is the correct outcome for a failure we do not understand.

`PricingApi_concurrentCreates_oneSucceedsOneConflicts` issues both creates with
`Promise.all`; a companion test forces the constraint path deterministically by
holding an uncommitted competing insert open.

---

## 4. Idempotency — a documented deviation from `api-standards.md` §6

`api-standards.md` §6 specifies **Redis-backed** idempotency keys. Stage 7 uses
**PostgreSQL**, deliberately.

A Redis key cannot participate in a database transaction, so this is possible:

1. transaction commits — rule updated, audit row written
2. process dies before the Redis key is stored
3. client retries
4. the mutation runs again and a **second audit row** appears

That is the duplicate-audit outcome the brief forbids. Storing the key in the
same database, in the same transaction, makes step 2 unreachable: either
everything committed or nothing did.

Redis remains the store for rate limiting, where approximate state costs
nothing.

**Trade-off accepted:** no TTL, so expiry is explicit work.

### Retention and cleanup

A record is **active** until `created_at` is older than
`IDEMPOTENCY_RETENTION_HOURS` (default **48**) — a retry inside that window
replays the stored response. After it, the key is forgotten and a retry executes
as a new request. 48h is the upper end of `api-standards.md` §6, chosen so a
client retrying after a long outage still gets a replay rather than a duplicate
mutation.

`purge_expired_keys()` (`src/modules/maintenance/idempotency_cleanup.ts`) sweeps
expired rows in bounded batches, supported by
`idx_idempotency_keys_created_at`. It runs as a **one-off process**
(`npm run maintenance:purge-idempotency`) from the same image and config, per
`backend-standards.md` §1 — never as an in-process timer competing with request
handling. Production schedules it as an hourly **Azure Container Apps Job**; see
[infra/README.md](../infra/README.md#scheduled-maintenance-idempotency-key-cleanup).

Three properties the tests pin down:

- **An active key is never deleted.** The cutoff is computed once per run, so a
  key that is unexpired when the run starts survives it however long the run
  takes.
- **Overlapping runs are safe.** `DELETE` takes a row lock and re-checks; the
  loser finds the row gone and skips it. No error, no double-count. A batch is
  therefore abandoned only when it returns **zero** rows, not when it returns
  fewer than `batch_size` — a short batch may just mean a concurrent run took
  some, and exiting there would leave expired rows behind while reporting a
  clean finish.
- **It cannot reach tenant data.** It connects as `bullion_maintenance`, which
  holds `BYPASSRLS` (cleanup is inherently cross-tenant) but is granted
  `SELECT, DELETE` on `idempotency_keys` and nothing else. It is not granted
  `UPDATE`, which is why the batch query carries no `FOR UPDATE SKIP LOCKED`:
  widening the grant so a stored response could be rewritten, in order to
  optimise a background job, is the wrong trade.

Every run logs `idempotency.cleanup.completed` at `info` **even when it deletes
nothing**, so "the job ran and found nothing" and "the job stopped running" stay
distinguishable. Hitting the batch cap additionally logs a `truncated` warning.

### Semantics

| Case | Result |
|---|---|
| Key unseen | Execute; store status + body in the same transaction |
| Key seen, same fingerprint | Replay stored response, `meta.replayed = true` |
| Key seen, **different** fingerprint | `409` |
| Concurrent same key | `409` — the loser of the primary-key race |

The fingerprint (`sha256` of method + path + canonical body) matters: without
it, a client reusing a key for a genuinely different change would receive the
earlier response and believe a change was applied that never was. Object keys
are sorted before hashing so a reordered retry is recognised as the same
request; **array order is preserved**, because it is meaningful.

Keys are scoped per tenant, so the same key in two tenants is two independent
requests.

---

## 5. Audit consistency

> **An audit row exists if and only if the mutation it describes committed.**

`write_audit` takes a `Prisma.TransactionClient`, **never** a `PrismaClient`.
The type is the enforcement: an audit row cannot be written outside the
transaction performing the mutation. Both failure modes the brief names —
mutation without audit, audit without mutation — are unreachable rather than
merely unlikely.

```
with_context(db, context, async (tx) => {
  ← idempotency lookup
  ← mutation
  ← write_audit            all one transaction
  ← store idempotent response
})
```

### Failures are logged, not audited

A rejected mutation leaves **no** audit row. That keeps the table's meaning
exact — *everything in it happened*. A table mixing attempts with facts forces
every reader to filter, and a reader who forgets draws the wrong conclusion.

Failed attempts and permission violations are recorded as structured log events
(`backend-standards.md` §5): security telemetry, not history of state.
`PricingApi_failedMutation_writesNoAuditRow` asserts it.

### What is recorded

Tenant · actor id · **actor type** · **actor role at the time** · action ·
entity type · entity id · before/after snapshots · `__changed` field list ·
request id · IP · user agent · timestamp.

Actor facts come from the **derived context**, never from a request.
`PricingApi_auditActor_isTheAuthenticatedUserNotAClaimedOne` sends an
`X-Actor-Id` header naming another tenant's user and asserts it is ignored.

`actor_role` is stored because roles change; an audit trail that re-interprets
history through today's role cannot answer "who was allowed to do this?".

### What is never recorded

Snapshots pass through an **allowlist** (`AUDITABLE_PRICING_FIELDS`), not a
denylist. A column added to the table later cannot reach an audit row unless
someone adds it deliberately — which matters because audit rows are durable and
widely readable within a tenant. No tokens, secrets, passwords or credentials.
`bigint` is stringified, never `Number()`-ed, so monetary precision survives.

### Append-only, enforced twice

- `REVOKE UPDATE, DELETE ON audit_logs FROM bullion_app`
- a `BEFORE UPDATE OR DELETE` trigger that raises

No application path — including a bug in the audit module — can rewrite history.
RLS restricts each tenant to its own rows.

### Reading

`GET /audit-logs` requires `manager`, not `staff`: audit history is management
information. Keyset pagination on a monotonic `id`, stable under concurrent
inserts in a way `OFFSET` is not. The view withholds `actor_user_id`,
`ip_address` and `user_agent` — retained for incident response, not for browsing.

---

## 6. Pricing semantics preserved

| Concept | Where it lives |
|---|---|
| Market/base rate | `market_data`, mock provider only |
| Purity conversion | `purity.ts`, **before** the adjustment |
| Configured absolute adjustment | `adjustment_value`, milli-paise/gram |
| Configured percentage adjustment | `adjustment_bps`, integer basis points |
| Raw customer rate | exact `Rational`, no rounding |
| Display rounding | `rounding_step_paise` + `rounding_mode` |
| Rounding delta | computed independently, ADR-0005 |

**The configured adjustment is authored, never derived.** It is stored as
configured and rendered from the column the rule's *kind* selects.
`PricingApi_configuredAdjustment_isUnchangedByDisplayRounding` sets the rounding
step to ₹0.01, ₹1, ₹10 and ₹100 in turn and asserts the stored ₹50/g never
moves by a paise.

Switching kind **zeroes** the unused column, so a rule switched from percentage
to absolute cannot retain stale basis points a later reader might apply.

No second pricing engine was created; the API calls the Stage 3 engine.

---

## 7. Running

```bash
npm run test:integration --workspace apps/api   # includes pricing_api.test.ts
npm run test:isolation   --workspace apps/api   # unchanged, still green
```
