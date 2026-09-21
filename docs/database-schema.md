# Database Schema

PostgreSQL 16. Conventions per `database-best-practices.md`: plural snake_case tables, singular descriptive
columns, `idx_<table>_<column>` indexes, `pk_`/`fk_`/`uq_`/`chk_` constraint prefixes.

**Money rule:** every rate is `BIGINT` **milli-paise per gram** (`RATE_SCALE` = 1000). No `FLOAT`, no
`REAL`, no `DOUBLE PRECISION` anywhere in this schema. The sub-paise scale exists because ₹236,908/kg
silver is 23,690.8 paise per gram — whole paise would lose ₹8/kg. See
[ADR-0003](adr/0003-integer-paise-per-gram.md).

---

## Entity overview

```
users ──┬── tenant_users ──┬── tenants ──┬── tenant_branding      (1:1)
        │                  │             ├── tenant_contacts      (1:1)
        └── platform_admins│             ├── customer_links       (1:N, rotatable)
                           │             ├── tenant_products      (N:M → products)
                           │             ├── tenant_pricing_rules (1:N)
                           │             ├── published_rates      (1:N)
                           │             ├── rate_update_events   (1:N)
                           │             └── audit_logs           (1:N)

metals ── products ── (global catalog, not tenant-owned)
market_rates            (global, not tenant-owned)
provider_health_events  (global, not tenant-owned)
```

Tenant-owned tables — all carry `tenant_id` and all have RLS enabled:
`tenant_branding`, `tenant_contacts`, `customer_links`, `tenant_products`, `tenant_pricing_rules`,
`published_rates`, `rate_update_events`, `audit_logs`, `tenant_users`.

Global tables — deliberately not tenant-scoped: `users`, `platform_admins`, `metals`, `products`,
`market_rates`, `provider_health_events`.

---

## Identity and tenancy

### `tenants`
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | UUIDv7. **Never exposed publicly.** |
| `legal_name` | `TEXT NOT NULL` | Registered firm name |
| `status` | `tenant_status NOT NULL` | `pending` \| `active` \| `suspended` |
| `suspended_at`, `suspended_reason` | `TIMESTAMPTZ`, `TEXT` | Platform admin action |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL` | |

A `suspended` tenant's public page returns 404 and its dashboard is read-only.

### `users`
Local mirror of Microsoft Entra identity, joinable locally. Entra owns
credentials — **no password hash column exists here.**

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `external_object_id` | `UUID NOT NULL` | Entra `oid` |
| `external_directory_id` | `UUID NOT NULL` | Entra `tid` |
| `email` | `CITEXT NOT NULL` | `uq_users_email` |
| `full_name`, `last_login_at` | `TEXT`, `TIMESTAMPTZ` | |

`uq_users_external_identity` is unique on **(`external_directory_id`,
`external_object_id`)** — Entra's `tid` + `oid`. Deliberately **not** `sub`:
Entra subjects are pairwise per application, so the same shopkeeper reaching us
through a second app registration would present a different `sub` and look like
a new user. See [ADR-0006](adr/0006-entra-external-id.md).

### `tenant_users`
Junction resolving user → tenant with a role. **The authorization source of truth.**

`PRIMARY KEY (tenant_id, user_id)` · `role tenant_role NOT NULL` — `owner` \| `manager` \| `staff` ·
`uq_tenant_users_user_id` enforces one tenant per user in v1 (drop this to allow multi-shop operators) ·
`idx_tenant_users_user_id` for the hot login lookup.

### `platform_admins`
`user_id UUID PK REFERENCES users(id)`, `granted_by`, `granted_at`. A separate table, not a role value — no
string a shopkeeper can set grants platform access.

### `customer_links`
Public URL identifiers, rotatable so a shopkeeper can revoke a shared link without changing tenant identity.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `tenant_id` | `UUID NOT NULL` FK | |
| `slug` | `CITEXT NOT NULL` | `/r/{slug}` |
| `is_active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `revoked_at`, `created_by` | `TIMESTAMPTZ`, `UUID` | |

```sql
CREATE UNIQUE INDEX uq_customer_links_active_slug
  ON customer_links (slug) WHERE is_active;
```
Partial unique index: slugs are unique among *active* links, while revoked slugs are retained so an old shared
link resolves to "this link was replaced" rather than silently landing on another shop. Slug format is
`chk_customer_links_slug_format`: `^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$`, with a reserved-word denylist
(`api`, `admin`, `health`, …).

### `tenant_branding` / `tenant_contacts`
1:1 with `tenant_id` as PK. Branding holds `display_name`, `logo_blob_path`, `logo_content_type`,
`logo_updated_at`, `accent_color` (`chk_` hex format), `tagline`. Contacts holds `phone_e164`,
`whatsapp_e164`, `public_email`, address lines, `city`, `state`, `pincode`, and `show_*` booleans governing
what reaches the public page.

Logos are referenced by blob path, never by user-supplied URL — see ARCHITECTURE.md §8.

---

## Product catalog

### `metals` (lookup)
`code TEXT PK` — `GOLD`, `SILVER` — plus `display_name`, `reference_purity_num/den` (999/1000),
`conventional_display_unit`.

### `products` (global catalog)
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `metal_code` | `TEXT NOT NULL` FK | |
| `purity_num`, `purity_den` | `INTEGER NOT NULL` | 916/1000. **Integers — never a float.** |
| `purity_basis` | `purity_basis NOT NULL` | `fine_ratio` for bullion grades, `market_convention` for karat grades — [ADR-0004](adr/0004-per-product-purity-basis.md) |
| `label`, `sort_order` | `TEXT`, `INTEGER` | "Gold 22K (916)" |
| `is_active` | `BOOLEAN NOT NULL` | |

`chk_products_purity_positive`: `purity_num > 0 AND purity_den > 0 AND purity_num <= purity_den`.
Seeded: Gold 999/995/916/750/585, Silver 999/925. Shared across tenants; tenants enable and reorder, they do
not define metallurgy.

### `tenant_products`
`PRIMARY KEY (tenant_id, product_id)`, with `is_enabled`, `display_order`, `display_unit`
(`per_gram` \| `per_10_gram` \| `per_kilogram`), and `show_base_rate BOOLEAN NOT NULL DEFAULT FALSE`.

`show_base_rate` is the configurable disclosure from your brief: `FALSE` shows customers only
"Gold 22K — ₹9,150/g"; `TRUE` also reveals market rate and shop adjustment.

---

## Market data

### `market_rates`
Append-only history of validated provider ticks. Global — not tenant-scoped.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | High write volume; UUID is wasteful here |
| `source` | `market_source NOT NULL` | `ibja` \| `spot` \| `mcx` \| `mock` |
| `provider_name`, `symbol` | `TEXT NOT NULL` | `goldprice_dev`, `XAU_INR` |
| `bid_per_gram` | `BIGINT` | Milli-paise. Nullable — not every source quotes two-way |
| `ask_per_gram` | `BIGINT` | Milli-paise |
| `mid_per_gram` | `BIGINT NOT NULL` | Milli-paise. What pricing consumes |
| `purity_num`, `purity_den` | `INTEGER NOT NULL` | Reference purity of the quote |
| `provider_timestamp` | `TIMESTAMPTZ NOT NULL` | **The vendor's stamp — shown to users** |
| `ingested_at` | `TIMESTAMPTZ NOT NULL` | Ours. Never shown as "last updated". |
| `raw_payload` | `JSONB` | For dispute resolution |

`chk_market_rates_positive`: `mid_per_gram > 0` · `idx_market_rates_symbol_provider_ts (symbol, provider_timestamp DESC)` ·
`idx_market_rates_ingested_at` for retention sweeps. Range-partition by month once volume justifies it.

Storing both timestamps separately is what makes honest staleness reporting possible.

### `provider_health_events`
`provider_name`, `status` (`healthy` \| `degraded` \| `down`), `latency_ms`, `error_code`, `error_message`,
`created_at`. Powers `/health/market-data` and the admin dashboard.

---

## Pricing

### `tenant_pricing_rules`
The shopkeeper's configuration. Rules are data; the engine interprets them.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `tenant_id`, `product_id` | `UUID NOT NULL` FK | |
| `adjustment_kind` | `adjustment_kind NOT NULL` | `absolute` \| `percentage` |
| `adjustment_value` | `BIGINT NOT NULL DEFAULT 0` | Milli-paise per gram. Signed — negatives allowed. |
| `adjustment_bps` | `INTEGER NOT NULL DEFAULT 0` | Basis points. **Integer, so no float.** |
| `rounding_step_paise` | `INTEGER NOT NULL DEFAULT 100` | Display precision for the **final rate**. 1 = two decimals, 100 = nearest ₹1 |
| `rounding_mode` | `rounding_mode NOT NULL` | `half_up` \| `half_even` \| `ceil` \| `floor` |
| `component_precision_paise` | `INTEGER NOT NULL DEFAULT 1` | Display precision for the **breakdown lines**, independent of the above |
| `is_active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `created_by`, `created_at`, `updated_at` | | |

`uq_tenant_pricing_rules_active` — `UNIQUE (tenant_id, product_id) WHERE is_active` — guarantees exactly one
live rule per product per tenant, so "which rule applied?" is never ambiguous.

`chk_tenant_pricing_rules_bounds` caps `adjustment_bps` to ±10000 (±100%) and `adjustment_value` to a sane
range. A fat-fingered adjustment should be rejected by the database, not discovered by a customer.

Both adjustment columns always exist; `adjustment_kind` selects which the engine reads. Switching modes in the
UI therefore preserves the other value.

### `published_rates`
Current computed rate per tenant per product — the read model the public page and SSE serve.

`PRIMARY KEY (tenant_id, product_id)` (current state only, not history). Two precision tiers are stored
side by side, per [ADR-0005](adr/0005-rounding-and-breakdown-display-policy.md):

| Tier | Columns | Meaning |
|---|---|---|
| **Storage** | `raw_base_rate`, `raw_adjustment`, `raw_customer_rate` | Milli-paise per gram, before display rounding |
| **Display** | `base_display_paise`, `adjustment_display_paise`, `rounding_delta_paise`, `rate_display_paise` | Paise of `display_unit`, quantised |
| **Config** | `display_unit`, `component_precision_paise`, `rounding_step_paise` | Recorded so a rate can be re-derived exactly |

`raw_adjustment` is the shopkeeper's **configured** adjustment. It is computed from the pricing rule and
is never back-derived as `rate − base` — that subtraction is what silently turned a configured ₹50/g into
₹50.007/g in the original design.

Four constraints hold the semantics:

- `chk_published_rates_raw_balances` — `raw_base + raw_adjustment = raw_customer`, exactly. No residual is
  permitted at the raw tier; a mismatch there is an arithmetic bug, not rounding.
- `chk_published_rates_breakdown_reconciles` — `base_display + adjustment_display + rounding_delta =
  rate_display`. The customer-facing breakdown always adds up.
- `chk_published_rates_adjustment_matches_configured` — the displayed adjustment agrees with
  `raw_adjustment` to within one unit of component precision. **This is the constraint that rejects the
  original defect**: reconciliation alone cannot distinguish *₹500.00 + ₹0.07 rounding* from
  *₹500.07 + ₹0.00*, and both would otherwise pass.
- `chk_published_rates_base_matches_raw` — the same binding for the market rate.

### `rate_update_events`
Append-only movement log driving the up/down indicator and history.

`tenant_id`, `product_id`, `old_rate_paise`, `new_rate_paise`, `direction` (`up`\|`down`\|`unchanged`),
`trigger` (`market_tick` \| `rule_change` \| `manual_recompute`), `market_rate_id`, `created_at`.
`idx_rate_update_events_tenant_created (tenant_id, created_at DESC)`. Range-partitioned monthly; retention
90 days hot.

`trigger` distinguishes "gold moved" from "the shopkeeper changed their margin" — needed for both the UI and
any later dispute.

---

## Audit

### `audit_logs`
| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | |
| `tenant_id` | `UUID NOT NULL` FK | |
| `actor_user_id` | `UUID` FK | Null for system actions |
| `action` | `TEXT NOT NULL` | `pricing_rule.updated`, `branding.updated`, … |
| `entity_type`, `entity_id` | `TEXT`, `TEXT` | |
| `old_value`, `new_value` | `JSONB` | |
| `ip_address` | `INET` | |
| `user_agent`, `request_id` | `TEXT` | Correlates to structured logs |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |

`idx_audit_logs_tenant_created (tenant_id, created_at DESC)` serves cursor pagination.
Append-only: `REVOKE UPDATE, DELETE` from the application role. Never contains secrets or full PII.

---

## Row-Level Security

RLS is layer 3 of tenant isolation — the backstop when application code is wrong.

```sql
ALTER TABLE tenant_pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pricing_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_pricing_rules
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
```

Applied to every tenant-owned table. Notes:

- **`FORCE ROW LEVEL SECURITY`** is required — without it the table owner bypasses its own policies, and the
  migration role usually is the owner.
- **`WITH CHECK`** blocks writes that would create a row under another tenant, not just reads.
- The application connects as a **non-owner, non-superuser role** (`bullion_app`). RLS does not apply to
  superusers, so connecting as one silently disables every policy in this section.
- Every request runs in a transaction opening with
  `SELECT set_config('app.current_tenant_id', $1, TRUE)` — `TRUE` scopes it to the transaction, so a pooled
  connection cannot carry one tenant's context into the next request.
- The `TRUE` in `current_setting(..., TRUE)` returns NULL rather than erroring when unset, so a context-free
  query returns **zero rows** instead of throwing — fail closed.
- Public endpoints set the context from the resolved slug, so the same policies protect anonymous traffic.

---

## Migrations and seeds

Prisma Migrate, forward-only, run as a discrete deploy step — never at app startup
(`deployment-best-practices.md` §7). RLS policies live in migration SQL alongside the tables they protect.

| Command | Purpose |
|---|---|
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:dev` | Create + apply during development |
| `npm run db:seed` | **Dev only** — guarded, refuses to run when `NODE_ENV=production` |
| `npm run db:reset` | Drop, migrate, seed |

Seeds cover reference data (metals, products) plus two fixture tenants — Sharma Jewellers (+₹50 gold, +₹2
silver) and Gupta Jewellers (+₹100 gold, −₹1 silver) — matching the brief so tenant isolation is visible from
the first run.
