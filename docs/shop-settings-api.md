# Shop Settings API

The shopkeeper-facing settings surface: how a shop presents itself, and which
products it quotes. Planned in [ARCHITECTURE.md](../ARCHITECTURE.md) §7 and
built here.

Composes existing infrastructure rather than reimplementing it — identity from
[authentication.md](authentication.md), isolation from
[tenant-isolation.md](tenant-isolation.md), recomputation through the same hook
the pricing API uses ([pricing-api.md](pricing-api.md)).

---

## 1. Why this exists

Before it, a shop created through onboarding was stuck. Its name was whatever
the sign-up form said and could never change. It had no contact details, so the
Call and WhatsApp actions on its customer page had nothing to point at. And
`tenant_products.show_base_rate` — the flag that decides whether customers see
the market rate beside the shop's own — was reachable only by a hand-written
`UPDATE`, so a self-onboarded shop could never show the breakdown at all.

Three tables existed with no way to write them. This is that way.

---

## 2. Endpoints

All under `/api/v1`, behind the `authenticate` middleware applied **at mount**,
so a route added later cannot be reached without a derived tenant context.

| Method | Path | Capability | Success |
|---|---|---|---|
| `GET` | `/tenant` | `tenant:read` | `200` `{data}` |
| `PATCH` | `/tenant` | `tenant:branding:write` | `200` `{data}` |
| `GET` | `/products` | `tenant:read` | `200` `{data, meta:{count}}` |
| `PATCH` | `/products/:product_id` | `tenant:branding:write` | `200` `{data}` |

No route takes a tenant identifier. The tenant comes from the verified token
(`oid` + `tid` → membership row), and both request schemas are `.strict()`, so
supplying `tenant_id`, `status` or `slug` in a body is a `422` rather than
something quietly ignored.

Pricing is deliberately not reachable from here. A margin is a different
decision under a different capability, and merging the two would mean one
careless `PATCH /tenant` could move money.

### Partial update semantics

`PATCH /tenant` applies only the keys present:

| In the body | Effect |
|---|---|
| absent | left alone |
| `null` | cleared |
| a value | set |

The distinction is load-bearing. "Remove my phone number" and "don't touch my
phone number" are different intentions, and the dashboard form relies on the
second: it diffs against what it loaded and sends nothing else, so two people
editing different fields do not overwrite each other.

An empty body is a `422` — there is nothing to do, and reporting success would
be a lie.

### No concurrency token

Unlike `PATCH /pricing-rules/:id`, these writes carry no `If-Match`. Losing a
race here costs a retyped tagline; losing one on an adjustment costs money. The
asymmetry is deliberate, not an omission.

---

## 3. Validation that is not cosmetic

`accent_color` is rendered into a style attribute on a public page. It is
constrained to a plain hex literal (`#abc` or `#aabbcc`) on the way **in**, not
only on the way out:

```
url(https://evil.test/x)   → 422
var(--surface-page)        → 422
red                        → 422
#fff; content: 'x'         → 422
#1d4ed8                    → 200
```

The frontend's `safe_accent` is the second line of defence, not the only one. A
value that reached the database could be read later by some consumer that
forgets to sanitise it, so it never gets there.

Phone numbers use a loose E.164 pattern rather than strict per-country rules: a
shopkeeper mistyping their own number is something they can see and fix, whereas
a validator that rejects a valid Indian landline is our bug.

---

## 4. `display_unit` is not a display preference

This is the one setting with a real consequence for correctness.

`published_rates.rate_display_paise` is an amount **in** its display unit.
Changing the unit therefore makes every stored rate for that product wrong until
it is recomputed — ₹14,081 per 10 grams read as per gram is out by a factor of
ten, which is exactly the kind of number a customer acts on.

So a unit change triggers a recompute **inside the same transaction** as the
setting, through the pipeline hook the pricing API already uses. The setting and
the rate it governs commit together, or neither does.

If no pricing rule exists for the product there is nothing to recompute and the
change simply applies. If a recompute cannot run, `published_rates.display_unit`
is stored alongside the amount and the public projection reports the unit the
row actually carries — a stale row is never reinterpreted as though it were in
the new unit.

`show_base_rate` needs no recompute. It is read at query time by
`get_public_rates`, which withholds the components when it is off. Nothing
stored changes, and the next read reflects the new choice.

The browser never rescales anything. A per-gram figure is not arrived at by
dividing a per-10g one in the dashboard, because that would be the frontend
pricing.

---

## 5. Disclosure is enforced by the API

`show_phone`, `show_whatsapp` and `show_address` are applied where the public
payload is built, in `to_public_shop`. A withheld number is **absent from the
response**, not hidden by CSS — so a customer cannot read it out of the page
source either.

---

## 6. Audit

Both endpoints write an audit row: `tenant_settings.updated` and
`tenant_product.updated`, with before and after snapshots.

Settings snapshots go through `AUDITABLE_SETTINGS_FIELDS`, an allowlist, the
same discipline the pricing audit uses. A column added to `tenant_contacts`
later cannot reach the audit log unless someone adds it there deliberately.
Audit rows are durable and readable across a tenant, so what goes into one is a
decision rather than a default.

`audit_logs.action` is a free `String` column, so extending the `AuditAction`
union needed no migration.

---

## 7. Code layout and tests

Each service is split the way `pricing_rule_service.ts` and
`pricing_rule_dto.ts` are, and for the same reason:

| File | Contains | Measured by |
|---|---|---|
| `tenant_settings_dto.ts` | request schema, audit allowlist, column mapping | unit |
| `tenant_settings_service.ts` | the transaction under RLS | integration |
| `tenant_products_dto.ts` | defaults, merge order, recompute decision | unit |
| `tenant_products_service.ts` | the transaction under RLS | integration |

The split is not cosmetic. The decisions in the `_dto` files are fully
determined by their inputs and are worth pinning down exhaustively and cheaply;
the services' correctness *is* their database behaviour, and a unit-mocked test
of those would assert that a mock was called rather than that isolation holds.
The service files and `routes/tenant.ts` are therefore excluded from the unit
coverage gate, as `vitest.config.ts` records.

- **Unit** (89 tests) — every accent-colour refusal, every field the schema must
  reject, that an absent field never becomes an `undefined` column write, that
  the audit allowlist drops an unknown field, and that `false`/`0` survive the
  merge (with `||` instead of `??`, a shopkeeper could never turn anything off).
- **Integration** (37 tests) — partial-update semantics, recompute wiring, and
  isolation: that a write by tenant A never changes tenant B's branding or
  product configuration, proven against real RLS as the non-owner application
  role.
- **Component** (36 tests) — the diff directly, since it decides what reaches
  the database, plus per-control saving, failure reporting, and re-seeding from
  the server's answer rather than from what was typed.

---

## 8. Not built here

- **Logo upload** (`POST /tenant/logo`). `tenant_branding.logo_blob_path` and
  `has_logo` exist and are read; nothing writes them, because blob storage is
  not yet wired.
- **Customer-link rotation** (`GET`/`POST /customer-link`). A shop keeps the
  slug onboarding gave it. `resolve_public_link` already distinguishes a revoked
  slug (`410`) from an unknown one (`404`), so the read side is ready.
- **Change history in the dashboard.** `fetch_audit_log` exists in the API
  client and the endpoint is live, but nothing renders it.
