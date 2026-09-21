# Tenant Isolation

> **The invariant:** a tenant can only observe or mutate data and events
> explicitly authorised for that tenant.

Enforced independently at four layers. Each is tested on its own, so a failure
in one does not mean a breach.

| # | Layer | Mechanism | Suite |
|---|---|---|---|
| 1 | API / service | Context-derived identity, tenant-filtered queries, field allowlists | `service_isolation.test.ts` |
| 2 | Database | PostgreSQL RLS, `FORCE`d, on every tenant-owned table | `rls_isolation.test.ts` |
| 3 | Realtime | Per-tenant channels + subscription authorisation | `realtime_isolation.test.ts`, `rate_channel.test.ts` |
| 4 | Public access | Slug resolution + allowlist projections | `public_access.test.ts` |

---

## 1. Tenant identity is derived, never accepted

Nothing takes a `tenant_id` from a caller who could be relaying browser input.
There are exactly two derivations:

```
Authenticated                             Public
─────────────                             ──────
verified principal (Entra oid+tid)        /r/{slug}
        │                                     │
        ▼                                     ▼
resolve_tenant_membership(sub)            resolve_public_link(slug)
        │                                     │
        ▼                                     ▼
AuthenticatedTenantContext                PublicTenantContext
{ tenant_id, user_id, role }              { tenant_id, slug }
```

Service functions take a **context** and no tenant id. A `tenant_id` in a body,
query string or header has nowhere to land — no function reads one.
`CreateRuleInput` deliberately has no `tenant_id` field, so the type system
refuses before RLS has to.

### Where the guarantee actually lives

A context *is* the authority. A hand-built context naming tenant B would reach
B's data — and `Adversarial_handBuiltContext_reachesOnlyTheTenantItNames`
documents that honestly rather than pretending otherwise. What makes it safe is
that **the sole producer of a context is derivation**, which reads membership
from the database using a verified principal and cannot be steered elsewhere.

### The bootstrapping problem, and why it is not solved by weakening RLS

`tenant_users` and `customer_links` are RLS-protected, yet they are exactly the
tables that must be read to discover *which* context to establish. With no
context set, RLS correctly returns zero rows and the application can never
start.

Two tempting fixes, both rejected:

- **Drop RLS from those tables** — they hold membership and public-link data and
  would become readable across tenants.
- **Allow access when no context is set** — a fail-open rule; every
  context-less query becomes a full scan.

Instead, two `SECURITY DEFINER` functions with a deliberately narrow contract
(migration `20260920170000_context_resolvers`):

```sql
resolve_tenant_membership(oid UUID, tid UUID)  -- principal → membership
resolve_public_link(slug TEXT)                 -- slug → tenant
```

They take a principal or a slug — **never a tenant id** — so they cannot be used
to look up an arbitrary tenant. `search_path` is pinned on both: without it a
`SECURITY DEFINER` function can be hijacked by a caller-controlled `search_path`
resolving `tenant_users` to an attacker's table. `EXECUTE` is revoked from
`PUBLIC` and granted only to the application role.

---

## 2. Database layer (RLS)

Every tenant-owned table has RLS **enabled and `FORCE`d**:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
```

- **`FORCE`** is essential — without it the table owner bypasses its own
  policies, and the migration role is the owner.
- **`WITH CHECK`** blocks writes that would create a row under another tenant,
  not just reads.
- The application connects as **`bullion_app`**: non-superuser, non-owner, no
  `BYPASSRLS`. PostgreSQL exempts superusers from RLS entirely, so connecting as
  one would silently disable every policy while appearing to work. Both the test
  suite and CI assert this before anything else runs.
- Context is set per transaction via
  `set_config('app.current_tenant_id', $1, TRUE)`. The `TRUE` scopes it to the
  transaction, so a pooled connection cannot carry one tenant's context into the
  next request.
- `current_setting(..., TRUE)` returns `NULL` when unset, and `tenant_id = NULL`
  is never true — so a context-free query returns **zero rows**. Fail closed.

A schema-introspection test asserts every table carrying a `tenant_id` column
has RLS enabled and forced, so a new tenant-owned table cannot ship unprotected.

---

## 3. Realtime layer

**There is no broadcast channel.** Every event is published to
`rates:tenant:{tenant_id}` and nowhere else, so a subscriber on one tenant's
channel cannot receive another's — those events are never written to a channel
it reads.

On top of that structural guarantee:

- `channel_for` accepts only a UUID. `*`, `rates:tenant:*`, `all` and path
  traversal are not expressible as channel names.
- `authorize_subscription` refuses to attach a subscriber to a channel its
  context does not own, before any Redis subscription is created. A requested
  tenant id is an assertion to **verify**, never an instruction to follow.
- **Platform admins are denied tenant channels.** An admin needing live rates
  uses admin endpoints; allowing an admin session here would create a path a
  role-confusion bug could ride.
- Defence in depth: even on its own channel, an event carrying a different
  `tenant_id` is dropped rather than relayed — catching a mis-routed publish
  instead of forwarding it. Malformed messages are dropped too.

### Asserting "received nothing" without a race

A naive negative assertion passes merely by checking too early. Every one here
waits for the *positive* delivery to land first, then asserts the other
subscriber's inbox is still empty — bounded by a real event, never a sleep.

---

## 4. Public customer access

Intentionally unauthenticated, so it gets its own model — **not** the
shopkeeper path with authentication skipped.

```
/r/{slug}
   │
   ▼  derive_public_context(slug)              server-side lookup only
customer_links WHERE slug = ? AND is_active
   │                                            revoked          → 410
   │                                            unknown          → 404
   │                                            tenant suspended → 404 (as unknown)
   ▼
PublicTenantContext { tenant_id, slug }        no user, no role
   │
   ▼  with_context(...)                         RLS bound to that tenant
tenant_branding · tenant_contacts · tenant_products · published_rates
   │
   ▼  to_public_shop / to_public_rate           allowlist projections
PublicShop / PublicRate
```

Reusing the dashboard path with a "public" flag is how private fields reach
anonymous visitors, so the two never share a code path. `PublicTenantContext`
carries no user and no role, and `has_role` returns `false` for it
unconditionally.

### What is never emitted

Internal ids (`tenant_id`, `product_id`, rule ids, user ids, `external_object_id`),
the registered legal name, pricing configuration (`adjustment_value`,
`adjustment_bps`, `rounding_step_paise`, `is_active`, `created_by`), raw pricing
tiers (`raw_base_rate`, `raw_adjustment`, `raw_customer_rate`), audit logs,
member lists, logo blob paths, provider credentials and system internals.

Projections are **allowlists**: adding a column to a table cannot leak it —
someone has to add it here on purpose. Tests compare **exact key sets**, not a
denylist, so a new field fails the suite rather than shipping quietly.

`show_base_rate = false` removes the market rate and adjustment from the payload
**entirely**, not merely hides them in the UI where a visitor could read around
it.

A suspended tenant is indistinguishable from a missing one; a revoked slug
returns 410 so an old shared link can say "this link was replaced" rather than
silently resolving elsewhere.

---

## 5. Adversarial coverage

Every attempt below is tested, at the layer where it would be made.

| Attempt | Expected | Where |
|---|---|---|
| Tenant B rule id in a Tenant A route | `403`, indistinguishable from unknown id | service |
| Tenant B id in the request body | Ignored; A's row changes, B's does not | service |
| Tenant B id in `CreateRuleInput` | Row created under A | service |
| Tenant A UUID used as a rule id | `403` | service |
| Cross-tenant `UPDATE` | `403`, B byte-identical afterwards | service + RLS |
| Cross-tenant `DELETE` | `403`, row survives | service + RLS |
| Cross-tenant `INSERT` | RLS `WITH CHECK` violation | RLS |
| Re-assigning own row to tenant B | RLS violation | RLS |
| No tenant context | Zero rows on every table; writes rejected | RLS |
| Invalid tenant context | Zero rows or a cast error — never a full scan | RLS |
| Tenant A context → tenant B channel | `RealtimeAuthorizationError` | realtime |
| Wildcard channel subscription | Rejected | realtime |
| Mis-routed event on own channel | Dropped, not delivered | realtime |
| Platform admin → tenant channel | Denied | realtime |
| Tenant B UUID used as a public slug | `404` | public |
| SQL injection / LIKE wildcards in a slug | `404`; tables intact | public |
| Audit log `UPDATE` / `DELETE` | Rejected (append-only trigger) | RLS |

### Existence oracles

A resource belonging to another tenant and one that does not exist return the
**same status, code and message**. Permission is checked before existence
(`backend-standards.md` §5), so responses cannot be used to enumerate what
exists. Asserted directly by
`TenantIsolation_unknownIdAndForeignId_areIndistinguishable`.

---

## 6. Running the suite

```bash
npm run test:isolation --workspace apps/api   # all four layers
npm run test:integration --workspace apps/api # + coverage thresholds
```

Requires PostgreSQL and Redis (`docker compose up -d`) and a migrated
`bullion_test` database.

Integration files run **sequentially** (`fileParallelism: false`): each suite
truncates and reseeds the same fixture tenants, and a flaky isolation suite is
worse than none.

In CI the isolation suite is a **separate required gate** that runs before the
broader integration job, so an isolation failure is never buried inside an
unrelated red build. A preceding step asserts `bullion_app` has neither
`rolsuper` nor `rolbypassrls` — without it the whole suite could pass while
enforcing nothing.
