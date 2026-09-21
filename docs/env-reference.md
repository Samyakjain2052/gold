# Environment Variable Reference

Every variable is **validated with Zod at startup**. A missing or malformed required value causes the process
to **exit non-zero before serving traffic** (`api-standards.md` §9) — a misconfigured deploy must fail at
deploy time, not at the first customer page view.

No named environment groups (`backend-standards.md` §3) — granular variables only.

**Tiers:** 🌐 browser-visible (never a secret) · 🔒 server-only · 🏗️ build/CI only.

---

## API service

### Core

| Variable | Tier | Required | Example | Notes |
|---|---|---|---|---|
| `NODE_ENV` | 🔒 | ✓ | `production` | `development` \| `test` \| `production` |
| `PORT` | 🔒 | | `8080` | Default 8080 |
| `LOG_LEVEL` | 🔒 | | `info` | `debug` dev only |
| `API_BASE_URL` | 🔒 | ✓ | `https://api.example.com` | Absolute URLs in responses |
| `PUBLIC_WEB_URL` | 🔒 | ✓ | `https://app.example.com` | Customer link generation |
| `ALLOWED_ORIGINS` | 🔒 | ✓ | `https://app.example.com` | Comma-separated. **Rejected if `*` when `NODE_ENV=production`.** |

### Database

| Variable | Tier | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | 🔒 | ✓ | Key Vault. **Must connect as `bullion_app`, not owner or superuser — RLS does not apply to superusers.** Validated to include `sslmode=require` in production. |
| `DATABASE_POOL_MAX` | 🔒 | | Default 10 |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 🔒 | | Default 10000 |
| `DATABASE_MAINTENANCE_URL` | 🔒 | job only | Key Vault. Connects as `bullion_maintenance` (`BYPASSRLS`, granted `SELECT, DELETE` on `idempotency_keys` and nothing else). Read **only** by the cleanup job, never by the API. |

`DATABASE_MAINTENANCE_URL` deliberately has **no fallback**, and the job exits
`78` rather than guessing.

Falling back to `DATABASE_URL` would delete nothing — RLS hides every row from a
session with no tenant context — so the job would report success while the table
grew without bound. Falling back to `DATABASE_MIGRATION_URL` would actually
work, since Azure's administrator is not a superuser but does hold `BYPASSRLS`
(measured on the server: `bullion_owner` is `rolsuper=f, rolbypassrls=t`). It is
still refused, on least privilege: that role owns every table and has full DDL
rights, and an unattended hourly job should not carry them.

### Idempotency cleanup (job only)

Read by `npm run maintenance:purge-idempotency`, not by the API — the service
does not require them to boot, and a missing value there must not block a
deploy. See [infra/README.md](../../infra/README.md#scheduled-maintenance-idempotency-key-cleanup).

| Variable | Tier | Required | Notes |
|---|---|---|---|
| `IDEMPOTENCY_RETENTION_HOURS` | 🔓 | | Default 48. How long a stored response stays replayable; after this a retry carrying the same key executes again. Upper end of `api-standards.md` §6. |
| `IDEMPOTENCY_CLEANUP_BATCH_SIZE` | 🔓 | | Default 1000, max 50000. Rows per transaction. |
| `IDEMPOTENCY_CLEANUP_MAX_BATCHES` | 🔓 | | Default 100. Per-run cap; hitting it logs a `truncated` warning and the next run continues. |

### Redis

| Variable | Tier | Required | Notes |
|---|---|---|---|
| `REDIS_URL` | 🔒 | ✓ | Key Vault. `rediss://` required in production |
| `REDIS_KEY_PREFIX` | 🔒 | | Default `bullion:` |

### Authentication (Microsoft Entra External ID)

| Variable | Tier | Required | Notes |
|---|---|---|---|
| `AUTH_ISSUER` | 🔒 | ✓ (prod) | Expected `iss`. Entra v2.0 issuer, e.g. `https://<sub>.ciamlogin.com/<guid>/v2.0` |
| `AUTH_AUDIENCE` | 🔒 | ✓ (prod) | Expected `aud` — this API's Application ID URI |
| `AUTH_DIRECTORY_ID` | 🔒 | ✓ (prod) | Expected `tid`. **Pins tokens to our directory** |
| `AUTH_JWKS_URL` | 🔒 | | Derived from `AUTH_ISSUER` if unset |
| `AUTH_ALLOWED_CLIENT_IDS` | 🔒 | | Permitted `azp` values. Empty = any in-directory client |

**Production refuses to boot** without the first three. Each is independently
sufficient to make verification meaningless:

- no **issuer** → nothing to validate `iss` against;
- no **audience** → a token minted for any other API is accepted;
- no **directory** → a validly signed token from *any* other Entra directory
  carrying our audience is accepted. Microsoft calls this the confused-deputy
  problem.

There is deliberately **no development bypass** — no flag disables verification,
so none can be left on by accident. Local work points at your own Entra External
ID tenant.

### JWT verification

| Variable | Tier | Default | Notes |
|---|---|---|---|
| `AUTH_JWT_ALGORITHMS` | 🔒 | `RS256` | **All-asymmetric or all-symmetric.** A mixed list is rejected at startup — permitting both enables algorithm confusion, where a public key is replayed as an HMAC secret. `none` is never accepted. An **algorithm/key-source mismatch** is also rejected: asymmetric without a JWKS, or symmetric pointed at one. `RS256` verified against the live Entra discovery document. |
| `AUTH_CLOCK_TOLERANCE_S` | 🔒 | `5` | Skew allowance on `exp`/`nbf`. Capped at 120: a large value silently extends the life of expired tokens. |
| `AUTH_MAX_FUTURE_IAT_S` | 🔒 | `60` | Rejects tokens issued implausibly far ahead — a broken or hostile issuer. |
| `AUTH_MAX_TOKEN_AGE_S` | 🔒 | `0` | Absolute age cap regardless of `exp`. 0 disables. |

### JWKS cache

| Variable | Tier | Default | Notes |
|---|---|---|---|
| `AUTH_JWKS_CACHE_MAX_AGE_MS` | 🔒 | `600000` (10 min) | Bounds how long a revoked key stays usable, while keeping refreshes rare |
| `AUTH_JWKS_COOLDOWN_MS` | 🔒 | `30000` | Minimum gap between refreshes triggered by an unknown `kid`. **Load-bearing:** `kid` is attacker-controlled, so without a cooldown a flood of forged kids becomes a DoS against the identity provider. Must be below the cache max age, or rotation is never picked up. |
| `AUTH_JWKS_STALE_GRACE_MS` | 🔒 | `86400000` (24 h) | How long known-good keys keep being served while refreshes fail. Generous on purpose: during a provider outage, verifying against last-known-good keys is far safer than rejecting every authenticated request. |
| `AUTH_JWKS_FETCH_TIMEOUT_MS` | 🔒 | `5000` | Keeps a hanging JWKS endpoint off the auth critical path |

### Market data

| Variable | Tier | Required | Example | Notes |
|---|---|---|---|---|
| `MARKET_DATA_PROVIDER` | 🔒 | ✓ | `mock` | `mock` \| `goldprice_dev` \| `metalprice_api` \| `ibja` \| `composite` |
| `MARKET_DATA_API_KEY` | 🔒 | cond. | | Required unless provider is `mock`. **Never `NEXT_PUBLIC_`.** |
| `MARKET_DATA_BASE_URL` | 🔒 | | | Override for sandbox |
| `MARKET_DATA_SYMBOLS` | 🔒 | ✓ | `XAU_INR,XAG_INR` | |
| `IBJA_API_KEY` | 🔒 | cond. | | Required for `ibja` / `composite` |
| `IBJA_BASE_URL` | 🔒 | cond. | | |
| `MARKET_POLL_INTERVAL_MS` | 🔒 | | `60000` | Below the provider's refresh rate wastes quota |
| `MARKET_POLL_MARKET_HOURS_ONLY` | 🔒 | | `true` | Cuts monthly call volume ~40% |
| `MARKET_HOURS_IST` | 🔒 | | `09:00-23:30` | |
| `MARKET_RATE_SANITY_MAX_MOVE_BPS` | 🔒 | | `500` | Ticks moving >5% are rejected, not published |

### Freshness thresholds

Two thresholds, three states: `fresh` | `stale` | `expired`.

| Variable | Tier | Default | Meaning |
|---|---|---|---|
| `FRESHNESS_STALE_AFTER_MS` | 🔒 | `120000` (2 min) | Beyond this a quote is **stale**: still shown, explicitly marked |
| `FRESHNESS_EXPIRED_AFTER_MS` | 🔒 | `600000` (10 min) | Beyond this a quote is **expired**: not shown, and pricing refuses to publish from it |

Derived from the 60s poll interval rather than picked for roundness: 2 minutes is two missed polls (one is
jitter, two is a signal); 10 minutes is ten, by which point gold has moved enough that the rate must not
underpin a counter quote. Startup rejects `stale >= expired`, which would make the stale state unreachable.

Full reasoning in [market-data-contract.md](market-data-contract.md) §2. Raising them to hide a flaky feed
means showing customers stale prices styled as live.

### Realtime

| Variable | Tier | Default | Notes |
|---|---|---|---|
| `SSE_HEARTBEAT_MS` | 🔒 | `20000` | Must stay below Azure's ~240s idle timeout |
| `SSE_MAX_CONNECTIONS_PER_REPLICA` | 🔒 | `5000` | Shed load rather than exhaust memory |
| `MARKET_POLLER_LEADER_LOCK_TTL_MS` | 🔒 | `30000` | Redis leader lock — **one poller cluster-wide** |
| `MARKET_POLLER_ENABLED` | 🔒 | `true` | `false` on API replicas when the poller runs separately |

### Storage

| Variable | Tier | Required | Notes |
|---|---|---|---|
| `AZURE_STORAGE_ACCOUNT_NAME` | 🔒 | ✓ | |
| `AZURE_STORAGE_CONTAINER_LOGOS` | 🔒 | ✓ | e.g. `tenant-logos` |
| `AZURE_STORAGE_CONNECTION_STRING` | 🔒 | | Local dev only — production uses managed identity |
| `LOGO_MAX_BYTES` | 🔒 | | Default `2097152` (2 MB) |
| `LOGO_ALLOWED_TYPES` | 🔒 | | `image/png,image/jpeg,image/webp` — **SVG deliberately absent** |

### Rate limiting

| Variable | Tier | Default |
|---|---|---|
| `RATE_LIMIT_PUBLIC_PER_MIN` | 🔒 | `120` |
| `RATE_LIMIT_AUTH_PER_MIN` | 🔒 | `300` |
| `RATE_LIMIT_LOGIN_PER_15MIN` | 🔒 | `10` |

### Observability

| Variable | Tier | Notes |
|---|---|---|
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | 🔒 | Key Vault |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 🔒 | Optional |
| `SERVICE_NAME` | 🔒 | Default `bullion-api` |

---

## Web (Next.js)

Anything prefixed `NEXT_PUBLIC_` is **compiled into the browser bundle and is world-readable.** No secret may
appear here — the market-data key in particular lives only on the API.

| Variable | Tier | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 🌐 | ✓ | API origin |
| `NEXT_PUBLIC_AUTH_AUTHORITY` | 🌐 | ✓ | Entra External ID authority URL |
| `NEXT_PUBLIC_AUTH_CLIENT_ID` | 🌐 | ✓ | Public client id. A browser app holds no secret — PKCE instead |
| `NEXT_PUBLIC_AUTH_SCOPES` | 🌐 | ✓ | Scopes requested for the API |
| `NEXT_PUBLIC_SITE_URL` | 🌐 | ✓ | Canonical URLs, OG tags |

A CI check fails the build if any `NEXT_PUBLIC_*` name matches `/KEY|SECRET|TOKEN|PASSWORD/` and is not the
Entra public client id.

---

## CI/CD (GitHub Secrets)

| Secret | Tier | Purpose |
|---|---|---|
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | 🏗️ | OIDC federated auth — no stored credentials |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | 🏗️ | SWA deploy |
| `ACR_NAME` | 🏗️ | Container registry |

---

## Local development

`.env.example` is committed with placeholders; `.env` is git-ignored and never committed. Docker Compose
supplies Postgres and Redis.

A working local setup needs no vendor account at all:

```
MARKET_DATA_PROVIDER=mock
DATABASE_URL=postgresql://bullion_app:devpassword@localhost:5432/bullion
REDIS_URL=redis://localhost:6379
```

`MARKET_DATA_API_KEY` is not required while the provider is `mock` — the conditional validator enforces this,
so nobody needs a paid subscription to run the project.

---

## Production secret handling

Production secrets live in **Azure Key Vault**, referenced from Container Apps by managed identity as
`keyvaultref:<URI>,identityref:<ID>`. Version is omitted from the URI so rotation is picked up within ~30
minutes without a redeploy.

Dev and production share no credentials. Rotation: market-data key quarterly;
database credentials on personnel change. `pino` redaction covers `authorization`, `cookie`,
`*.api_key`, `*.password`, and `*.token` so secrets cannot reach logs even when an object is logged whole.
