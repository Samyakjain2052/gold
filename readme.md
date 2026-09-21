# Bullion Rates Platform

Multi-tenant live gold and silver rate platform for Indian jewellery shops.

A shopkeeper configures their pricing once. Their customers open a branded link and see live rates derived
from that configuration — no account, no app, no login.

> **Status: Stages 1–6 complete.** Scaffold, config, health, CI (1); schema, migrations, RLS,
> seed (2); pricing engine (3); market-data provider abstraction + `MockMarketDataProvider` (4);
> JWT verification and the authenticated-context boundary (5); four-layer tenant-isolation suite
> (6); pricing configuration API + audit trail (7). Authentication migrated from
> Supabase to **Microsoft Entra External ID**. **790 tests** — 600 unit, 190
> integration. Azure infrastructure is written as Bicep but **not provisioned**.
> Next: stage 8 (SSE fan-out).

---

## The idea

```
Sharma Jewellers  →  app.example.com/r/sharma-jewellers  →  Gold 22K  ₹9,150/g   (market +₹50)
Gupta Jewellers   →  app.example.com/r/gupta-jewellers   →  Gold 22K  ₹9,200/g   (market +₹100)
```

One market feed, per-shop pricing, complete tenant isolation. A customer of one shop can never see another
shop's rates, settings, or data.

## Documents

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, stack, pricing engine, tenant isolation, realtime, auth, API, security, deployment |
| [docs/market-data-providers.md](docs/market-data-providers.md) | Provider research and comparison, licensing findings, recommendation |
| [docs/database-schema.md](docs/database-schema.md) | Tables, money representation, RLS policies, migrations |
| [docs/env-reference.md](docs/env-reference.md) | Every environment variable, with secret tiering |
| [docs/testing-strategy.md](docs/testing-strategy.md) | Test layers, coverage gates, the tenant-isolation suite |
| [docs/pricing-examples.md](docs/pricing-examples.md) | Worked calculations, generated from the engine |
| [docs/market-data-contract.md](docs/market-data-contract.md) | Quote schema, freshness policy, provider lifecycle, reconnect/duplicate/ordering behaviour |
| [docs/tenant-isolation.md](docs/tenant-isolation.md) | The four enforcement layers and the adversarial coverage matrix |
| [docs/pricing-api.md](docs/pricing-api.md) | Endpoints, concurrency, idempotency, audit consistency |
| [docs/authentication.md](docs/authentication.md) | JWT verification, JWKS rotation, context derivation, authorization matrix |
| [infra/README.md](infra/README.md) | Azure resources, costs, and the Entra External ID prerequisites |
| [docs/adr/](docs/adr/) | Architecture decision records |

## Decisions already made

| Decision | Choice | Record |
|---|---|---|
| Runtime split | Next.js on Static Web Apps + Express on Container Apps | [ADR-0001](docs/adr/0001-stack-and-runtime-split.md) |
| Authentication | Microsoft Entra External ID (RS256 + JWKS) — Azure-native, no Supabase | [ADR-0006](docs/adr/0006-entra-external-id.md) |
| Rate basis | IBJA-anchored, spot for intraday movement | [ADR-0002](docs/adr/0002-ibja-anchored-rate-basis.md) |
| Money | Integer milli-paise per gram, everywhere | [ADR-0003](docs/adr/0003-integer-paise-per-gram.md) |
| Purity basis | Per-product: bullion vs karat grades convert differently | [ADR-0004](docs/adr/0004-per-product-purity-basis.md) |
| Rounding & breakdown | Configured adjustment is never derived; rounding disclosed on its own line | [ADR-0005](docs/adr/0005-rounding-and-breakdown-display-policy.md) |
| Styling | CSS Modules, snake_case — team standard, no Tailwind | [ARCHITECTURE.md §2](ARCHITECTURE.md) |
| Market data | `mock` only today — every paid provider is blocked pending written licensing confirmation | [providers §3.1](docs/market-data-providers.md) |

## Three things worth knowing up front

**Development costs nothing.** `MARKET_DATA_PROVIDER=mock` simulates moving prices, so every realtime feature
can be built and tested without a vendor account. No free tier is legally usable in production, and **no paid
provider is approved yet** — see the [open blockers](docs/market-data-providers.md).

**Market-data consumption is decoupled from customer count.** One leader-elected poller serves every tenant
and every connected browser, so provider call volume follows the polling interval rather than signups. Our own
infrastructure — SSE connections, Redis, storage — does still scale with tenants and concurrent viewers.

**Real-time is not faked.** Every rate carries the provider's own timestamp and a freshness state. When the
feed goes quiet the page says so and stops presenting itself as live.

## Setup

No vendor account and no API key required — the defaults run entirely on mock data.

```bash
cp .env.example .env         # works as-is for local development
docker compose up -d         # PostgreSQL :5432, Redis :6380
npm install
npm run db:generate -w apps/api
npm run db:migrate  -w apps/api   # schema + RLS policies
npm run db:seed     -w apps/api   # Sharma & Gupta Jewellers fixtures
npm run dev
```

Then:

```bash
curl localhost:8099/health/ready
npm test                                    # 499 unit tests
npm run test:isolation -w apps/api          # 97 tenant-isolation tests
npm run pricing:examples -w apps/api        # worked rate calculations
```

`.env.example` is committed with placeholders. `.env` is git-ignored and must never be committed.

### Two things that will bite you

**The app must not connect as a superuser or as the table owner.** PostgreSQL exempts superusers from
row-level security, and owners bypass their own policies. Connecting as either silently disables every
tenant-isolation policy while appearing to work perfectly. `DATABASE_URL` uses `bullion_app`;
`DATABASE_MIGRATION_URL` uses `bullion_owner` and is read only by the Prisma CLI.

**Redis is on host port 6380**, not 6379, because 6379 is so often already taken. Override with
`REDIS_HOST_PORT`.
