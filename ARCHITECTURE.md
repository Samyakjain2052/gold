# Bullion Rates Platform — Architecture

Multi-tenant live bullion rate platform for Indian jewellery shops. A shopkeeper configures their pricing
once; their customers open a branded public link and see live rates derived from that configuration.

> **Status:** Stages 1–3 implemented (scaffold/config/health/CI, schema/migrations/RLS/seed,
> pricing engine). Stage 4 (market-data provider abstraction) is next.
> **Companion documents:** [market-data-providers.md](docs/market-data-providers.md) ·
> [database-schema.md](docs/database-schema.md) · [env-reference.md](docs/env-reference.md) ·
> [testing-strategy.md](docs/testing-strategy.md) · [pricing-examples.md](docs/pricing-examples.md) ·
> [ADRs](docs/adr/)

---

## 1. Product model in one picture

```
                IBJA AM/PM fix  +  XAU/INR spot (intraday movement)
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  Market Data Service      │  single leader-elected poller
                    │  validate → sanity check  │  ONE provider call serves everyone
                    └───────────┬───────────────┘
                                ▼
                    ┌───────────────────────────┐
                    │  Redis: latest + pub/sub  │
                    └───────────┬───────────────┘
                                ▼
                    ┌───────────────────────────┐
                    │  Pricing Engine (pure)    │  purity → adjustment → rounding
                    └───────────┬───────────────┘
                                ▼
          ┌─────────────────────┴──────────────────────┐
          ▼                                            ▼
  Sharma Jewellers (+₹50)                     Gupta Jewellers (+₹100)
  /r/sharma-jewellers                         /r/gupta-jewellers
          │                                            │
      SSE stream                                   SSE stream
   (tenant-scoped channel)                   (tenant-scoped channel)
```

A tenant's computed rate is published **only** to that tenant's channel. There is no broadcast path that
carries one tenant's rate to another tenant's subscribers.

---

## 2. Technology selection

Chosen to match the team's existing standards documents rather than introduce a parallel stack.

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 App Router, TypeScript strict, **CSS Modules** | `frontend-best-practices.md` §1, §5 — CSS Modules, no Tailwind |
| Component system | Hand-built, design tokens in `globals.css` | No shadcn: it is Tailwind-coupled |
| Backend | **Express + TypeScript** modular monolith | `backend-standards.md` §2; monolith per your brief |
| Validation | Zod at every boundary | `backend-standards.md` §2 |
| ORM | Prisma | `backend-standards.md` §6 |
| Database | Azure PostgreSQL Flexible Server | `deployment-best-practices.md` §1 |
| Cache / pub-sub | Azure Cache for Redis | Rate limiting, idempotency, fan-out |
| Auth | **Microsoft Entra External ID** (OIDC / RS256 JWT) | Azure-only deployment; see ADR-0006 |
| Object storage | Azure Blob Storage | `deployment-best-practices.md` §1 |
| Realtime | **SSE** (not WebSocket) | See §6 |
| HTTP client | `undici` + `cockatiel` | `api-standards.md` §9 |
| Logging | `pino` structured JSON → App Insights | `backend-standards.md` §7 |
| IaC / CI | Bicep + GitHub Actions (OIDC) | `deployment-best-practices.md` §3 |
| Tests | Vitest + Supertest + Testcontainers + Playwright | `testing-best-practices.md` |

### Why a separate backend rather than Next.js API routes

Not a stylistic preference — a hard constraint. `api-standards.md` §11 states: *"Never use serverless for
persistent DB/TCP connections without an external pooler."* Next.js on Azure Static Web Apps runs its server
code on managed Azure Functions, which cannot hold the long-lived SSE connections or the persistent provider
feed this product is built on.

So: **Next.js on Static Web Apps for rendering only; Express on Container Apps owns all state, all
connections, and all pricing.** This also satisfies your requirement that the browser never computes a
trusted price — the browser has no pricing code at all.

### Repository layout

```
/apps
  /web                 Next.js — public rate page + shopkeeper dashboard
  /api                 Express modular monolith
    /src
      /modules
        /auth          JWT verification, tenant context resolution
        /tenants       onboarding, branding, contacts
        /pricing       pricing engine (pure) + rules + audit
        /market_data   provider abstraction, poller, health
        /realtime      SSE hub, Redis pub/sub bridge
        /public        customer-facing read-only projections
        /admin         platform-owner endpoints
      /platform        db, redis, config, logging, errors, money
      /http            middleware, router, problem+json
/packages
  /contracts           Zod schemas + inferred types shared by web and api
/infra                 Bicep
/docs
```

`packages/contracts` is the single source of truth for request/response shapes. The frontend imports the same
types the backend validates against, so a drift becomes a compile error.

---

## 3. Pricing engine

### 3.1 Money representation

**Every rate is a `BIGINT` of milli-paise per gram.** One decision, applied everywhere.

| Aspect | Rule |
|---|---|
| Currency | INR only (v1). `currency_code` column present for future use. |
| Canonical unit | **milli-paise per gram** (`RATE_SCALE` = 1000), integer |
| Storage | PostgreSQL `BIGINT` |
| Display unit | Per-tenant, per-product: `per_gram`, `per_10_gram`, `per_kilogram` |
| Purity | Integer `purity_num` / `purity_den` (916/1000), never a float |
| Percentage | **Basis points**, integer (`adjustment_bps`; 1 bp = 0.01%) |
| Rounding | Explicit step + mode, applied once, over an exact rational |

Floating point never appears in a pricing path. Gold at ₹15,372.70/g is `1_537_270_000`; a 64-bit integer
holds this with enormous headroom.

The three extra digits are not decoration. Indian silver is quoted per kilogram, and ₹236,908/kg is
23,690.**8** paise per gram — whole paise would truncate and lose ₹8 per kilogram. At milli-paise every
supported quote unit converts in with no rounding at all. See [ADR-0003](docs/adr/0003-integer-paise-per-gram.md).

Display conversion is presentation only: gold is conventionally quoted per 10 g and silver per kg in India,
but both are *stored* per gram so no calculation ever has to know which unit a product uses.

### 3.2 The pipeline

Pure functions, no I/O, exhaustively unit-testable:

```
raw_base_rate     = base_rate × purity_ratio(target, basis)     exact — ADR-0004
raw_adjustment    = configured adjustment, from the rule alone  exact — ADR-0005
raw_customer_rate = raw_base_rate + raw_adjustment              exact

rate_display      = round(raw_customer_rate, display precision, mode)
```

**Order is load-bearing and deliberate.** Purity conversion comes *before* the shop adjustment, because a
jeweller's ₹50 margin is ₹50 on the metal they are actually selling — not ₹50 on 999 that then gets shrunk to
₹45.80 by a 916 conversion. Measured cost of inverting it: **₹42 per 10 g** on 22K gold. It is asserted in
the test suite, not just documented here.

**Rounding happens exactly once**, from the exact total rather than from rounded components. The first
stages produce an unevaluated rational (`num`/`den`), so no intermediate value is ever rounded.

**The configured adjustment is an input, not a derived value.** It is computed from the pricing rule
alone and never as `rate − base`; a configured +₹50/g reports as exactly ₹500.00 per 10 g at any
rounding step. Any residual between the displayed lines and the displayed total is disclosed as its own
`rounding` line — see [ADR-0005](docs/adr/0005-rounding-and-breakdown-display-policy.md) and the worked
figures in [pricing-examples.md](docs/pricing-examples.md).

The engine is a function of `(base_rate, pricing_rule)` and nothing else. No database handle, no clock, no
config lookup. That is what makes the correctness tests meaningful.

### 3.3 Extensibility

The rule is data, not code. `tenant_pricing_rules` rows describe the adjustment; the engine interprets them.
Supporting "Gold 22K = market + 3% + ₹20" later means adding a rule kind and a branch in one `apply_adjustment`
function — not touching call sites. Per-product rules are the default, so the Gold 24K / Gold 22K / Silver 999
example in your brief is the ordinary case, not a special one.

---

## 4. Tenant isolation

Four independent layers. Any one of them failing alone does not leak data.

**Layer 1 — Identity is derived, never accepted.**
`tenant_id` is never read from a request body, query string, or header. For authenticated requests it comes
from the verified Entra JWT (`oid`+`tid`) → `tenant_users` lookup. For public requests it comes from resolving the URL slug
server-side. A request *cannot express* which tenant it wants to act as.

**Layer 2 — Repository signatures.**
Every tenant-scoped repository method takes `tenant_id` as its first parameter. A Prisma client extension
injects `where: { tenant_id }` into every query on a tenant-owned model, so omitting it is not possible
through the normal path.

**Layer 3 — PostgreSQL Row-Level Security.**
Each request runs inside a transaction that begins with `SET LOCAL app.current_tenant_id`. RLS policies on
every tenant-owned table filter on `current_setting('app.current_tenant_id')`. This is the backstop that
catches an ORM mistake or a hand-written query — the database refuses to return the rows regardless of what
the application asked for.

**Layer 4 — Explicit public projections.**
Public endpoints never serialise an entity. They pass through an allowlist mapper
(`to_public_shop_dto`, `to_public_rate_dto`) that names every field it emits. Adding a column to a table
cannot leak it to customers; someone has to add it to the mapper on purpose.

Supporting decisions: tenant primary keys are UUIDv7 and never appear in a public response. The public slug
is a separate, rotatable identifier held in `customer_links` — a shopkeeper can revoke a shared link without
changing their tenant.

§13 of [testing-strategy.md](docs/testing-strategy.md) covers how this is proven rather than asserted.

---

## 5. Authentication and authorization

- **Shopkeepers** authenticate against Microsoft Entra External ID, which issues short-lived RS256 JWTs.
- **The backend verifies independently** against the Entra JWKS using `jose` — signature, algorithm, `kid`,
  `iss`, `aud`, `exp`, `nbf`, `iat`, and the `tid` directory claim. A token is never trusted because the
  frontend sent it.
- **`auth_context` middleware** resolves `{ user_id, tenant_id, role }` and attaches it to the request.
  Handlers read tenant identity only from here.
- **RBAC at the service layer** (`owner` / `manager` / `staff`), checked *before* resource existence, so a
  cross-tenant probe returns `403` and not a `404` that confirms the row exists — `backend-standards.md` §5.
- **Customers do not authenticate.** The public page is anonymous by design; it is rate-limited by IP and
  serves only allowlisted fields.
- **CSRF:** the API is Bearer-token only and accepts no cookie authentication for state-changing requests,
  which puts it in the exempt category of `authentication.md` §9. Enforced by a strict CORS allowlist and by
  rejecting any request that attempts cookie auth on a mutating route.
- **Platform admins** are a separate table (`platform_admins`), not a tenant role. Admin routes mount under a
  distinct router with its own guard; there is no role string a shopkeeper can obtain that grants admin access.

---

## 6. Realtime architecture

### Why SSE rather than WebSocket

The customer page is strictly server→client. The only thing a client needs to say is "which tenant," and that
is already in the URL. Given that, SSE wins on every axis that matters here: it is plain HTTP/2 with no upgrade
handshake, `EventSource` reconnects automatically with `Last-Event-ID` built in, it passes through Container
Apps ingress and CDNs without special configuration, and there is no separate authentication dance.

WebSocket would be the right call if customers sent messages. They don't. Choosing it anyway would add a
protocol and a failure mode to carry capability nothing uses.

### Flow

1. The **poller** (leader-elected, see below) fetches from the configured provider.
2. Response is **schema-validated with Zod** and sanity-checked against the last known rate — a move beyond a
   configured threshold is rejected as a bad tick and alerted on, not published.
3. Stored: `SET market:latest:{symbol}` in Redis + an append to `market_rates` for history.
4. The **pricing engine** recomputes rates — but only for tenants with at least one live subscriber, tracked
   in a Redis set. Idle tenants are computed lazily on their next page load.
5. Results publish to `rates:tenant:{tenant_id}` on Redis pub/sub.
6. Every API replica subscribes to Redis and relays to *its own* connected `EventSource` clients for that
   tenant only.
7. The client applies a subtle count-up animation and updates the "last updated" stamp.

A shopkeeper changing an adjustment enters at step 4 for their tenant alone, after validation and an audit
write.

### One poll serves everyone

The poller runs as a **single leader-elected worker** holding a Redis lock, never once per replica.

This **decouples market-data consumption from browser and customer count**. Provider call volume is a function
of the polling interval and market hours alone — adding tenants or concurrent viewers does not add provider
calls. That is what makes "hundreds of unnecessary API calls" structurally impossible.

It is *not* a claim that running costs are flat. **Our own infrastructure does scale with tenants and
concurrent connections:**

| Grows with | Cost driver |
|---|---|
| Concurrent SSE connections | Container Apps replicas (memory and file descriptors per open connection) |
| Concurrent connections | Redis pub/sub throughput and connection count |
| Tenants × products | Per-tick pricing recomputation, `published_rates` writes |
| Tenants × time | `rate_update_events` and `audit_logs` growth, storage and retention |
| Tenants | Blob storage for logos, database size |

Provider spend is decoupled; compute, cache, and storage are not. Polling is further restricted to market
hours, cutting monthly provider volume roughly 40%.

### Honest freshness

Every payload carries `provider_timestamp`, `computed_at`, `source`, and a `freshness` discriminant:

| State | Condition | Customer sees |
|---|---|---|
| `live` | within the expected interval | Green dot, "Updated 14s ago" |
| `delayed` | beyond interval, within stale threshold | Amber dot, "Updated 3m ago" |
| `stale` | beyond stale threshold | Grey, "Last known rate · 20 Sep 4:42 PM", pulse stops |
| `unavailable` | beyond hard threshold, or no valid rate | Rates hidden, "Please contact the shop" |

The UI renders the provider's timestamp, never the server's fetch time. Because IBJA fixes twice daily and
spot polls on an interval, the page states its actual basis — "IBJA PM fix · 20 Sep + live spot movement" —
rather than implying tick-level data it does not have. A stale rate is never styled as live.

### Provider failure

Per `api-standards.md` §9: rate limiter → bulkhead → circuit breaker → timeout → retry → pool, implemented
with `cockatiel`. Retries use full jitter `random(0, min(30s, 2^attempt))`, capped at 3, honouring
`Retry-After`, never retrying 4xx. On circuit open, the last known valid rate is served and immediately
marked `stale`; the failure is logged with the provider, latency, and error code, and written to
`provider_health_events`. SSE clients reconnect with capped backoff indefinitely, since a customer leaving
their phone open overnight must recover without a refresh.

---

## 7. API design

`/api/v1/` base path. `{data, meta}` / `{error}` envelope. Errors as RFC 9457 `application/problem+json` with
a request ID on every response. Cursor pagination on audit logs.

### Public — no auth, IP rate-limited, allowlisted fields

| Method | Path | Returns |
|---|---|---|
| `GET` | `/public/shops/:slug` | Branding, contacts, enabled products, display config |
| `GET` | `/public/shops/:slug/rates` | Current published rates + freshness |
| `GET` | `/public/shops/:slug/stream` | SSE stream, tenant-scoped |

### Shopkeeper — Bearer JWT, tenant from token

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me` | Session user + tenant summary |
| `GET` `PATCH` | `/tenant` | Firm name, brand, contacts, address |
| `POST` | `/tenant/logo` | Logo upload (§8) |
| `GET` | `/products` | Catalog + per-tenant enablement and order |
| `PATCH` | `/products/:id` | Enable/disable, display order, display unit, show-base-rate |
| `GET` `PUT` | `/pricing-rules` | Read / replace adjustment set |
| `POST` | `/pricing-rules/:product_id/adjust` | Increment / decrement / set / reset-to-market |
| `GET` | `/rates/preview` | Exactly what customers currently see |
| `GET` | `/customer-link` | Current link; `POST /rotate` to revoke and reissue |
| `GET` | `/audit-logs` | Cursor-paginated change history |
| `GET` | `/stream` | Dashboard SSE |

Mutating pricing endpoints accept `Idempotency-Key` (Redis, 24h TTL) per `api-standards.md` §6.

### Platform admin — separate guard

`/admin/tenants` (list, suspend, activate), `/admin/health`, `/admin/provider-status`, `/admin/connections`.

### Health

`/health/live` (no dependencies) and `/health/ready` are separate endpoints with separate logic per
`backend-standards.md` §7, plus `/health/market-data`, `/health/database`, `/health/redis`.

---

## 8. Security model

Transport and headers are `helmet`, HTTPS-only, HSTS, a strict CORS allowlist per environment (never `*`),
and `express.json({ limit: '1mb' })`. Redis-backed `express-rate-limit` covers every public endpoint,
returning `429` with `Retry-After` — in-memory limiting is useless across replicas.

Input is validated with Zod at the boundary; Prisma parameterises all SQL; React escapes output and
`dangerouslySetInnerHTML` is banned in review.

**Logo upload** gets specific treatment because it is the one place a tenant hands us a file:
≤2 MB; PNG/JPEG/WebP only, determined by **magic-byte sniffing, not the `Content-Type` header**;
**SVG is rejected outright** as a scripting vector; the image is **re-encoded through `sharp`**, which strips
EXIF and neutralises polyglot payloads; it is stored in Blob Storage under a random name, never under a
user-supplied path, and served from storage rather than the app origin.

Secrets live in Key Vault, referenced by managed identity, never in source or images. Config is validated at
startup and the process **refuses to boot** if a required variable is missing — a missing provider key should
fail loudly at deploy, not silently at the first customer page view. `pino` redaction keeps tokens, keys, and
PII out of logs. Audit rows record actor, tenant, action, before/after, IP, and request ID.

---

## 9. Observability

Structured JSON to stdout → Container Apps → Log Analytics + Application Insights. Every log line carries
request ID, timestamp, severity, and service name. OpenTelemetry traces propagate across HTTP boundaries.

Tracked: provider connection state and latency, provider error rate, seconds since last successful market
update, live SSE connection count (total and per tenant), pricing calculation failures, authentication
failures, rate-limit rejections.

The alert that matters most is **seconds-since-last-successful-update** crossing the stale threshold — it is
the single signal that the product is showing customers something it should not.

---

## 10. Deployment

| Component | Azure service | Notes |
|---|---|---|
| Web | Static Web Apps | PR previews free |
| API | Container Apps | `minReplicas: 1`, `--timeout-keep-alive 75` |
| Market poller | Container Apps | `minReplicas: 1` — must **not** scale to zero |
| Database | PostgreSQL Flexible Server | B1ms dev, General Purpose prod, `sslmode=require` |
| Cache | Azure Cache for Redis | Basic C0 dev |
| Logos | Blob Storage | Soft delete + versioning |
| Secrets | Key Vault | Managed identity, no version pin |
| Images | ACR | Tagged with commit SHA and `latest` |
| Telemetry | App Insights + Log Analytics | |

GitHub Actions with OIDC federated credentials — no stored Azure secrets. Path-based triggers. Blue/green via
Container Apps revision labels with traffic splitting. Migrations run as a discrete step, never at app startup.

Estimated production cost: **~$45–75/month** of Azure plus **~$30/month** for market data.

---

## 11. Build sequence

Each stage ends somewhere demonstrable.

| # | Stage | Outcome |
|---|---|---|
| 1 | Scaffold, config validation, health endpoints, CI | Deploys green |
| 2 | Schema, migrations, RLS policies, dev seed | `npm run db:reset` works |
| 3 | **Pricing engine + money module, fully tested** | Correctness locked before anything depends on it |
| 4 | Provider abstraction + `MockMarketDataProvider` | Rates move locally, no vendor |
| 5 | Entra JWT verification, tenant context, RBAC | Verified identity → context → RLS |
| 6 | **Tenant isolation test suite** | Proven before features accumulate |
| 7 | Pricing APIs + audit log | Adjustments persist and are attributable |
| 8 | SSE hub + Redis fan-out | Two browsers, two tenants, independent updates |
| 9 | Public rate page (mobile-first) | The customer product |
| 10 | Dashboard UI | The shopkeeper product |
| 11 | Logo upload, branding, link rotation | Onboarding complete |
| 12 | Platform admin, observability, runbooks | Operable |
| 13 | Real provider behind the abstraction | One module changes |

Stages 3 and 6 come early on purpose: pricing correctness and tenant isolation are the two things that are
painful to retrofit and damaging to get wrong.
