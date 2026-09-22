# Stage 9 — production readiness audit

Audit of whether this system can move from local development to a real provider
and a real deployment once licensing is resolved. It is an audit, not a feature
stage: findings are recorded, small defects are fixed, and the one large gap is
scoped rather than built.

Nothing here declares the product production-ready. Passing tests are evidence
about the code that exists, not about the code that does not.

---

## 1. The vertical slice is severed

**This is the finding that matters.** Every component on the customer path
exists, is tested, and is individually sound. They are not connected.

```
provider → abstraction → validation → freshness → MarketDataService
                                                        │
                                                        ▼
                                              ✗ NOTHING CONSUMES THIS ✗
                                                        │
       ┌────────────────────────────────────────────────┘
       ▼
  pricing engine → published_rates → Redis publish → SSE → public API → SSR → browser
   (never called)   (never written)   (never called)   ✓      ✓         ✓      ✓
```

Verified by inspection of `apps/api/src`:

| Claim | Evidence |
|---|---|
| `MarketDataService` is never constructed | No reference outside `modules/market_data/` |
| The pricing engine is never invoked | No reference outside `modules/pricing/` |
| `published_rates` is never written | Only `public_service.ts:284` reads it; no `create`/`upsert`/`update` anywhere |
| No rate event is ever emitted | `publish_rate_event` has zero callers |

Consequences, all confirmed by running the system:

- The public page can only display rows inserted by a seed, a fixture, or by
  hand. On the dev database it correctly renders "No rates published yet".
- The SSE stream is fully functional and will never deliver an event, because
  no publisher exists.
- A shopkeeper's pricing edit updates `tenant_pricing_rules` and **does not
  update `published_rates`**, so it is invisible to customers indefinitely.

`ARCHITECTURE.md` §6 specifies the missing component (leader-elected poller →
recompute → publish). §13 claims onboarding a real provider means "one module
changes"; that is not currently true. Scope is itemised in
[production-provider-readiness.md](production-provider-readiness.md) §0.

Config for this component already exists and is dead: `MARKET_POLLER_ENABLED`,
`MARKET_POLLER_LEADER_LOCK_TTL_MS`, `MARKET_POLL_INTERVAL_MS`,
`MARKET_POLL_MARKET_HOURS_ONLY`, `MARKET_DATA_SYMBOLS`.

**Not built in this stage.** Building it is a feature stage, and the audit's job
was to find it, not to hide it by implementing it.

---

## 2. The authenticated path holds

Traced end to end; no gap found between adjacent components.

```
Entra token → JwtVerifier (RS256, iss/aud/tid/azp pinned)
            → VerifiedPrincipal (oid+tid, never the pairwise sub)
            → derive_context (SECURITY DEFINER resolver, RLS-safe)
            → require_capability
            → service layer
            → transaction: mutation + audit + idempotency, one commit
            → RLS (ENABLE + FORCE) on every tenant table
```

Each boundary re-derives rather than trusts: the route never reads a tenant from
the request, the context is built from the verified token alone, and RLS is the
backstop rather than the only control. The four-layer isolation suite (97 tests)
exercises this against a real database.

One inconsistency was found and fixed in Stage 8: `/me` read link revocation
from `revoked_at` while `resolve_public_link` decides it by `is_active`.

---

## 3. Defects found and fixed in this stage

### 3.1 The tracked-secrets CI guard never ran (critical)

```
grep -E '(^|/)\.env$|(^|/)\.env\.(?!example|template|sample)|\.pem$|…'
```

`(?!...)` is PCRE. It is **not valid ERE**, so `grep -E` rejects the entire
pattern and exits non-zero. The step is written as `if grep …; then fail; fi`,
so a rejected pattern takes the success path and prints "No forbidden files
tracked."

The control reported success while checking nothing. A committed `.pem`,
`.key`, `credentials.json`, `settings.local.json` or `.env.production` would
have passed CI.

Replaced with two greps (match, then subtract the allowlist), which is valid
ERE. Verified against a scratch repository: allowlisted `.env.example` and
`.env.template` pass; `.env`, `.env.production`, `server.key`, `tls.pem`,
`credentials.json` and `settings.local.json` are all caught.

### 3.2 The browser-exposure guard missed the most sensitive name

The `NEXT_PUBLIC_` check matched `SECRET|PASSWORD|SERVICE_ROLE|PRIVATE` but not
`KEY` or `TOKEN` — so `NEXT_PUBLIC_MARKET_DATA_API_KEY`, the exact value the
brief forbids reaching a browser, would have passed. Added `KEY`, `TOKEN`,
`CREDENTIAL`. No current variable matches; the five public variables are all
non-secret identifiers.

### 3.3 `/health/ready` reported healthy with no market data

`market_data_health()` was a stub returning `not_configured`, and `aggregate()`
deliberately treats `not_configured` as a non-failure. So readiness returned
`200` for a replica that cannot price anything — and `cd.yml` gates its
deployment on exactly that endpoint. A deploy would have gone green over a
service with no rates.

Now `unhealthy` in production, `not_configured` elsewhere so local work and CI
are unaffected.

### 3.4 Authenticated responses were cacheable

`/pricing-rules` and `/audit-logs` set no `Cache-Control`, and `/pricing-rules`
sends an `ETag`, which makes a response heuristically cacheable. A browser on a
shared showroom machine could retain one tenant's pricing and audit history
after sign-out. RFC 9111 §3.5 already stops *shared* caches storing responses to
requests bearing `Authorization`; this closed the private half.

`no-store, private` is now applied at the mount, beside `authenticate`, so a new
route cannot forget it.

### 3.5 Frontend had no CSP, no `frame-ancestors`, no HSTS

`X-Frame-Options: DENY` was set but its modern replacement was not. Added a CSP
built from what the app actually does — `connect-src` for the API origin and the
Entra authority, `img-src` for blob storage, `frame-ancestors 'none'` — plus
HSTS.

**Build-time constraint.** `next.config.ts` reads `NEXT_PUBLIC_API_BASE_URL` and
`NEXT_PUBLIC_AUTH_AUTHORITY` when the headers are generated, which is at *build*
time — verified by serving a build made with one API origin while starting it
with another: the emitted `connect-src` carried the build-time value. This is
how every `NEXT_PUBLIC_` value already behaves, but the CSP makes a mismatch
fail confusingly (requests blocked by policy rather than returning 404). **The
frontend must be built with the production API and authority URLs**, and a
promotion of the same artefact between environments is not possible.

**Documented limitation:** `script-src` must include `'unsafe-inline'`. Next.js
App Router emits inline bootstrap and hydration scripts, and a nonce cannot be
applied to statically rendered output. Removing it breaks the app. This weakens
CSP's XSS value; `frame-ancestors`, `object-src 'none'` and `base-uri 'self'`
are unaffected.

### 3.6 Temporary database firewall rule removed

The rule named `setup`, opening `bullion-dev-pg` to a residential IP, was
created during Stage 8 provisioning and left in place. Deleted. The server now
has **zero** firewall rules.

---

## 4. Configuration audit

52 variables in `config.ts`. Classification below; `🔒` = secret,
`🔓` = non-secret, `🌐` = compiled into the browser bundle.

### Fails the process at startup in production

`config.ts` refuses to boot (exit `78`) unless all of these hold. This is the
fail-closed behaviour, verified by running the real image:

| Rule | Why |
|---|---|
| `MARKET_DATA_PROVIDER ≠ mock` | Simulated prices must never reach a customer |
| Provider not in `PRODUCTION_BLOCKED_PROVIDERS` unless `MARKET_DATA_LICENCE_CONFIRMED` | Licensing gate |
| `AUTH_ISSUER` set | Tokens cannot be verified without an expected issuer |
| `AUTH_AUDIENCE` set | Else a token minted for any other API is accepted |
| `AUTH_DIRECTORY_ID` set | `tid` pinning; confused-deputy defence |
| `AUTH_ISSUER` or `AUTH_JWKS_URL` set | Asymmetric verification needs a key source |
| `DATABASE_URL` contains `sslmode=require` | |
| `REDIS_URL` uses `rediss://` | |
| `ALLOWED_ORIGINS` excludes `*` | |

### Secrets — Key Vault only, never in Git, never `NEXT_PUBLIC_`

`DATABASE_URL`, `DATABASE_MIGRATION_URL`, `DATABASE_MAINTENANCE_URL`,
`REDIS_URL`, `MARKET_DATA_API_KEY`, `IBJA_API_KEY`,
`AZURE_STORAGE_CONNECTION_STRING`, `APPLICATIONINSIGHTS_CONNECTION_STRING`.

All are consumed server-side only. None appears in `apps/web`. Verified: the
repository contains exactly five `NEXT_PUBLIC_` names, all identifiers —
`API_BASE_URL`, `AUTH_AUTHORITY`, `AUTH_CLIENT_ID`, `AUTH_SCOPES`, `SITE_URL`.
A public client id is public by design; the browser holds no secret and uses
PKCE.

`.env` is gitignored and has never been staged; `.env.example` carries
placeholders only.

### Dead configuration

`MARKET_POLLER_ENABLED`, `MARKET_POLLER_LEADER_LOCK_TTL_MS`,
`MARKET_POLL_INTERVAL_MS`, `MARKET_POLL_MARKET_HOURS_ONLY`,
`MARKET_DATA_SYMBOLS`, `MARKET_HOURS_IST` — read by nothing, because the poller
does not exist (§1). Retained deliberately; they are the contract the poller
will use.

### Defaults that are wrong for a real provider

`FRESHNESS_STALE_AFTER_MS` (120s) and `FRESHNESS_EXPIRED_AFTER_MS` (600s) assume
a ~60s polling feed. For a twice-daily source such as IBJA every quote would be
`expired` within ten minutes. These must be set from the provider's real cadence
at onboarding.

---

## 5. CORS and browser security

**API.** `origin: config.ALLOWED_ORIGINS` (an explicit list; `*` refused in
production), `credentials: false`. Credentials-off is what makes the absence of
CSRF defences correct — this is a Bearer API with no cookie auth — so it is now
asserted by a test rather than left to review. Verified: an unlisted origin
receives no `Access-Control-Allow-Origin`.

`helmet()` in production supplies HSTS, `X-Content-Type-Options`,
`Referrer-Policy` and frameguard. CSP is disabled in development so the Next dev
server is not blocked; the API returns JSON, so CSP is of little consequence
there.

**SSE headers.** `Content-Type: text/event-stream`, `Cache-Control: no-store,
no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`. The last is
required: Container Apps ingress and any nginx in front of it will otherwise
buffer an event stream into uselessness.

**Cache-Control by surface:**

| Surface | Value | Reason |
|---|---|---|
| `/public/shops/:slug` | `public, max-age=60` | Branding changes rarely; keyed by slug, so a shared cache can only ever answer a shop's own URL |
| `/public/shops/:slug/rates` | `no-store` | Freshness is the product; a cached rate would contradict the freshness the payload reports |
| `/public/shops/:slug/stream` | `no-store, no-transform` | |
| All authenticated routes | `no-store, private` | §3.4 |

---

## 6. SSR and public-page caching

The risk: `/r/[slug]` is one route serving every shop. A cached render of
`/r/sharma-jewellers` served for `/r/gupta-jewellers` would be a cross-tenant
leak **above** the database, which no amount of RLS would catch.

Three independent controls, each now covered by a regression test in
`apps/web/tests/ssr_caching.test.ts`:

1. `export const dynamic = "force-dynamic"` — the route opts out of the full
   route cache entirely.
2. `export const revalidate = 0` — no time-based cache entry is created.
3. Both fetches pass `cache: "no-store"`, so Next's Data Cache holds nothing.
   `fetch_public_rates` hardcodes it rather than accepting it from a caller, so a
   page cannot opt back in.

The build output confirms the route is `ƒ (Dynamic) server-rendered on demand`.
Tests additionally assert the page reads no tenant identifier from
`searchParams`, `cookies()` or `headers()` — the slug is the only tenant
selector.

---

## 7. Realtime lifecycle and limits

`rate_hub.ts` holds one Redis subscription per **tenant** per replica, with
local fan-out. Covered by 20 unit tests: shared subscription, per-listener
authorisation, idempotent detach, last-viewer teardown, failed-subscribe
recovery, capacity shedding. Cross-tenant isolation is additionally proven over
real HTTP and real Redis in `public_stream.test.ts`.

**Documented limitations — not measured under load:**

| Concern | State |
|---|---|
| Connection ceiling | `SSE_MAX_CONNECTIONS_PER_REPLICA` defaults to 5000. Exceeding it sheds the newest connection with `503` + `Retry-After`. The number is a guess, not a measurement. |
| Backpressure | `res.write()` return value is ignored and there is no `drain` handling. A slow client's frames accumulate in the socket buffer. Frames are small and infrequent, so this is tolerable, but it is unbounded in principle. |
| Timers | One heartbeat `setInterval` per connection. At 5000 connections that is 5000 timers per replica. |
| Redis reconnect | Measured, not assumed. `CLIENT KILL TYPE pubsub` against the running server drops the subscriber; node-redis reconnects with capped jittered backoff **and restores the subscription**, and a message published afterwards is delivered. An earlier draft of this audit claimed subscriptions were lost; that was wrong. |
| Scale evidence | None. No load test has been run. No claim is made about concurrent connection capacity. |

---

## 8. Database and RLS

Verified against the **live Azure** database:

```
RLS enabled AND forced on 10/10 tenant tables
bullion_app          rolsuper=f  rolbypassrls=f  → 0 tenants visible without context
bullion_owner        rolsuper=f  rolbypassrls=t
bullion_maintenance  rolsuper=f  rolbypassrls=t  → grants: idempotency_keys only
```

Tenant context is transaction-scoped via `set_config(..., TRUE)` and is derived
server-side; no route accepts a tenant identifier. All 9 migrations are applied
and `prisma migrate status` reports no drift.

Indexes cover the high-frequency paths, including a partial unique index
`uq_customer_links_active_slug ON customer_links(slug) WHERE is_active` — the
hottest public query.

**Limitation:** a lookup for a *revoked* slug is not served by that partial
index and falls back to a scan. Revoked-slug traffic is rare (stale bookmarks),
so this is accepted rather than fixed.

---

## 9. Infrastructure and secrets

No plaintext credential appears in `main.bicep`; the admin password is
`@secure()` and passed at deploy time. TLS is enforced on PostgreSQL and Redis,
blob public access is disabled, ACR admin user is disabled, Key Vault is
RBAC-only with soft delete, and cross-service access uses a user-assigned
managed identity.

Key Vault holds `database-url`, `maintenance-database-url`,
`migration-database-url`, `postgres-admin-password`, `redis-url`. The database
passwords exist nowhere else.

**Open items:**

- `publicNetworkAccess: 'Enabled'` on PostgreSQL. With zero firewall rules
  nothing can currently reach it, but the correct posture is a VNet with a
  private endpoint. Container Apps will need *some* path to the database — adding
  "Allow Azure services" would also admit every other Azure tenant, so a private
  endpoint is the right answer, not a firewall rule.
- Redis and PostgreSQL still use password/connection-string auth rather than
  managed identity. Both support Entra authentication; moving to it would remove
  two secrets from Key Vault entirely.
- Application Insights is provisioned but the API does not emit to it
  (`APPLICATIONINSIGHTS_CONNECTION_STRING` is read by config and used by nothing).

---

## 10. Deployment sequence

`cd.yml` is `workflow_dispatch` only, which is correct while production cannot
start. Actual order:

```
1. verify        re-run the full CI suite against this exact commit
2. az login      OIDC federated credentials; no stored Azure password
3. acr build     image tagged with the commit SHA, never `latest`
4. firewall      open the runner's egress IP
5. migrate       prisma migrate deploy, as a discrete step
6. firewall      close it — `if: always()`, so a failed migration cannot leave it open
7. deploy        az containerapp update
8. verify        poll /health/ready for up to 5 minutes
```

Infrastructure (`main.bicep`) is deliberately outside this workflow; it is
applied by hand with `what-if` first.

**Can a deploy start with `MARKET_DATA_PROVIDER=mock`?** No. Three independent
barriers: config refuses to boot (exit `78`); the container therefore never
serves; and step 8 fails because `/health/ready` never returns 200. The job goes
red and the frontend is not deployed.

**Limitation:** `az containerapp update` in single-revision mode shifts traffic
to the new revision. A revision that crash-loops on bad configuration means the
app has no healthy revision. Production should use multi-revision mode with a
traffic split so the previous revision keeps serving until the new one is
verified. Not configured; the Container App does not exist yet.

**Frontend deployment is not implemented.** `cd.yml` deploys the API only.
Target is Azure Static Web Apps per `ARCHITECTURE.md` §3; nothing is provisioned.

Because `NEXT_PUBLIC_` values and the CSP are baked at build time (§3.5), the
frontend build must be parameterised per environment. There is no
build-once-promote-everywhere path.

---

## 11. Observability

Can production answer the question today?

| Question | Answer |
|---|---|
| Is the market provider connected? | **No** — `market_data_health()` is a stub; no provider runs |
| When was the last valid quote? | **No** — nothing ingests quotes at runtime |
| Is market data fresh/stale/expired? | Per published rate, yes (in the API payload). System-wide, no |
| How many SSE connections are active? | `hub.listener_count()` exists but **is not exposed** on any endpoint |
| How many tenant subscriptions? | `hub.channel_count()` exists, **not exposed** |
| Are Redis subscriptions reconnecting? | **No** — and §7 notes they would not re-subscribe |
| Are pricing mutations failing? | Partially — errors are logged with code and status, not counted |
| Are idempotency conflicts occurring? | Logged, not counted |
| Are JWKS/auth failures occurring? | Logged with a reason, never with the token |
| Cross-tenant authorization failures? | Logged as `403` with capability and context kind |
| PostgreSQL nearing limits? | **No** — pool metrics are not surfaced |

Logging is structured JSON (pino) with a request id on every line and every
response. No token, authorization header, secret or key is ever logged; MSAL's
own logger is disabled outright in the browser.

**Deliberately not added here.** The two cheap wins — exposing hub counts on
`/health` and wiring Application Insights — both belong with the poller work,
because most of the unanswerable questions are unanswerable for the same reason:
the component does not exist. Adding a metrics endpoint for a pipeline that does
not run would be instrumentation theatre.

---

## 12. Failure scenarios and user-visible behaviour

| Scenario | Behaviour | Verified |
|---|---|---|
| Redis unavailable | `/health/ready` → 503, replica pulled from traffic. Public REST pages still render (they read PostgreSQL). SSE connections fail; the page shows "Live updates unavailable" and keeps its server-rendered rates | Reasoned |
| PostgreSQL unavailable | `/health/ready` → 503. Public page shows "Rates are temporarily unavailable" — explicitly *not* "shop not found" | Tested (page path) |
| JWKS unavailable | Cached keys serve for `AUTH_JWKS_STALE_GRACE_MS` (24h). Beyond that, `401`. Dashboard shows the sign-in panel | Tested (unit) |
| Market provider unavailable | No effect today — nothing consumes it. After the poller: rates age `fresh → stale → expired` and the page says so | Partly |
| Provider sends malformed data | Rejected by `parse_quote` with a counted reason; last good quote retained | Tested (unit) |
| Provider stale | Freshness is computed at read time, so a quote that ages reports `stale` without anything touching it | Tested (unit) |
| API restart with SSE clients | Connections drop; `EventSource` reconnects automatically with its own backoff; page shows "Reconnecting" and keeps the last rates | Tested (component) |
| Redis reconnect | Client reconnects and node-redis restores the subscription; delivery resumes with no listener churn | Measured |
| Browser reconnect | Automatic; a transient error keeps rates on screen, a fatal one degrades to server-rendered values | Tested (component) |
| Duplicate provider quote | Rejected as `duplicate` | Tested (unit) |
| Deploy during active SSE | All connections drop at once and reconnect together. No jitter on the client side, so a large audience reconnects in a thundering herd. Not mitigated | Gap |
| Expired/rotated public link | `410` → "This link has been replaced", distinct from 404, and the new slug is deliberately not disclosed | Tested (integration + component) |
| Concurrent pricing update | Optimistic concurrency: `409`, and the UI says the change was *not* saved and offers a reload. Never silently retried | Tested (both) |
| Duplicate idempotency request | Same key + same fingerprint replays the stored response; different fingerprint → `409` | Tested (integration) |

---

## 13. Readiness matrix

| Area | State | Note |
|---|---|---|
| Market provider licensing | **BLOCKED** | No written redistribution or customer-display rights exist for any provider. Every real provider is in `PRODUCTION_BLOCKED_PROVIDERS`; `mock` is refused in production |
| Rate publication pipeline | **BLOCKED** | Poller, recompute and publish do not exist (§1). Licensing alone does not unblock the product |
| Frontend deployment | **BLOCKED** | No hosting provisioned, no pipeline |
| Redis subscription recovery | **READY** | Subscription survives a killed connection; verified against the running server |
| Tenant isolation (DB) | **READY** | RLS enabled + forced on 10/10 tables, verified on live Azure; app role cannot bypass; 97-test gate |
| Tenant isolation (realtime) | **READY** | Per-tenant channels, per-listener authorisation, proven over real HTTP and Redis |
| Tenant isolation (SSR/cache) | **READY** | Force-dynamic, no-store, regression-tested |
| Authentication | **READY** | RS256/JWKS, iss/aud/tid/azp pinned, keyed on `oid`+`tid`, fails closed |
| Pricing correctness | **READY** | Exact integer arithmetic, no float in the authoritative path, adjustment never derived |
| Audit and idempotency | **READY** | Append-only enforced by REVOKE + trigger; transactional idempotency |
| Concurrency | **READY** | Optimistic `version` + `If-Match`; 409/428 surfaced honestly |
| Secrets management | **READY** | Key Vault; no secret in Git; CI guards now actually work (§3.1, §3.2) |
| CORS and headers | **READY WITH DOCUMENTED LIMITATION** | CSP requires `script-src 'unsafe-inline'` for Next App Router (§3.5) |
| Database network posture | **READY WITH DOCUMENTED LIMITATION** | Zero firewall rules; `publicNetworkAccess` still Enabled, private endpoint recommended (§9) |
| Deployment pipeline | **READY WITH DOCUMENTED LIMITATION** | Cannot start with mock; single-revision mode is a rollback risk (§10) |
| Realtime scale | **READY WITH DOCUMENTED LIMITATION** | Correct and isolated; ceiling unmeasured, backpressure unbounded (§7) |
| Observability | **READY WITH DOCUMENTED LIMITATION** | Structured logs and health probes; no metrics, App Insights unwired (§11) |

No overall score is given. Three areas are BLOCKED, and the first two of them
mean no customer can be served a real rate regardless of what else is ready.

One claim in an earlier draft of this audit — that Redis subscriptions are not
restored after a reconnect — was tested and found false, and has been corrected
above rather than left as a plausible-sounding defect.
