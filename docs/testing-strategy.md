# Testing Strategy

Per `testing-best-practices.md`: one behaviour per test, independent tests, behaviour over implementation,
`<Feature>_<Scenario>_<ExpectedResult>` naming, no hard waits, stable `data-testid` selectors.

**Coverage gates (CI-enforced, failing the build):** ≥80% line, ≥70% branch, ≥90% on critical paths —
authentication, pricing calculation, and tenant isolation.

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | Pricing engine, money module, purity, rounding, providers |
| Integration | Vitest + Supertest + Testcontainers | API, auth, RLS, realtime |
| E2E | Playwright | Customer page, dashboard flows |

Integration tests run against **real PostgreSQL and Redis in Testcontainers**, never mocks. Mocked database
tests cannot prove RLS works, which is the thing most worth proving.

---

## 1. Tenant isolation — the suite that matters most

Your brief names this the most important test, so it is built at stage 6, before features accumulate.

Fixtures: **Tenant A** (Sharma Jewellers, gold +₹50) and **Tenant B** (Gupta Jewellers, gold +₹100), each with
an owner user, distinct pricing, and distinct public slugs.

### 1.1 Table-driven endpoint sweep

The high-value design decision: rather than hand-writing a test per endpoint — which silently misses whatever
someone adds next — the suite enumerates every tenant-scoped route from the router and drives them all.

```ts
// Every tenant-scoped route, authenticated as A, targeting B's resources.
for (const route of TENANT_SCOPED_ROUTES) {
  test(`TenantIsolation_${route.id}_deniesCrossTenantAccess`, async () => {
    const res = await request(app)
      .get(route.path_for(tenant_b))
      .set("Authorization", `Bearer ${token_for(user_a)}`);

    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(tenant_b.id);
    expect(JSON.stringify(res.body)).not.toContain("Gupta Jewellers");
  });
}
```

A new tenant-scoped endpoint added without isolation **fails this suite on the next run**. A guard test asserts
`TENANT_SCOPED_ROUTES` covers every mounted route, so the registry cannot silently fall behind.

Asserting the *response body* is free of B's identifiers — not just the status code — catches the case where a
handler returns 200 with leaked data.

### 1.2 The four proofs from your brief

| Requirement | Test |
|---|---|
| A cannot **read** B's data | `TenantIsolation_readTenantBPricing_returns403` |
| A cannot **modify** B's pricing | `TenantIsolation_patchTenantBRule_returns403AndLeavesRuleUnchanged` |
| A cannot **access** B's dashboard | `TenantIsolation_tenantBDashboard_returns403` |
| A's public URL cannot expose B | `PublicPage_tenantASlug_containsNoTenantBData` |

The modify test re-reads B's rule afterward and asserts it is byte-identical. A 403 with a completed write
would still be a breach.

### 1.3 Injection attempts

`tenant_id` supplied in a body, query string, or header must be **ignored**, not honoured:

```
PATCH /api/v1/pricing-rules  { tenant_id: <B>, adjustment_value: 999900 }
  → A's rule changes, B's does not.
```

Also covered: forged JWT with B's `tenant_id` claim → 401 (signature check); valid A token replayed against B's
slug-scoped public endpoints → no crossover; suspended tenant → 404.

### 1.4 RLS at the database layer

Bypasses the application entirely. Sets `app.current_tenant_id` to A, then `SELECT *` from every tenant-owned
table and asserts zero B rows — proving the backstop holds independently of the ORM.

```ts
test("RLS_tenantAContext_returnsNoTenantBRows", async () => {
  for (const table of TENANT_OWNED_TABLES) {
    const rows = await sql_as_app_role(table, { tenant_context: tenant_a.id });
    expect(rows.every(r => r.tenant_id === tenant_a.id)).toBe(true);
  }
});
```

Plus: **no tenant context set → zero rows** (fail closed, not fail open), and a `WITH CHECK` test proving an
insert carrying B's `tenant_id` under A's context is rejected by PostgreSQL.

A schema-introspection test asserts every table carrying a `tenant_id` column has RLS enabled and forced — so
a new tenant-owned table cannot ship unprotected.

---

## 2. Pricing correctness

Pure functions, no I/O — the cheapest place to buy the most confidence.

**Money module:** paise↔rupee conversion, display-unit conversion (per gram / 10 g / kg), no precision loss
across round trips, rejection of non-integer input. A guard test greps the pricing sources for `parseFloat`,
`Number(`, and `/ 100` on money paths and fails if found.

**Purity conversion:** 999→916, 999→750, 999→585, identity at 999→999, silver 999→925. Exact integer
expectations, hand-computed in the test, never derived by re-running the implementation.

**Rounding:** each mode (`half_up`, `half_even`, `ceil`, `floor`) at each step (₹1, ₹10, ₹100), including
exact-half boundaries — where `half_up` and `half_even` diverge and where naive implementations are wrong —
and negative adjustments producing values near zero.

**Adjustments:** absolute positive and negative; basis points including 0 bp, 50 bp, and 10000 bp; the bounds
rejected by `chk_tenant_pricing_rules_bounds`.

**The configured adjustment survives rounding** — the suite that exists because an earlier design derived it
as `rate − base` and turned a configured ₹50/g into ₹50.007/g. A configured +₹50/g must report as exactly
₹500.00 per 10 g across every display precision (2 decimals, ₹1, ₹10, ₹100), every rounding mode, and every
purity. Also asserted: an absolute adjustment is independent of the base rate, while a percentage adjustment
correctly scales with it. See [ADR-0005](adr/0005-rounding-and-breakdown-display-policy.md).

**Precision tiers stay separate** — raw (milli-paise per gram) reconciles exactly with no residual permitted;
display is quantised per the tenant's rule; the residual between them appears only in `rounding_delta_paise`
and never exceeds one rounding step.

**Order of operations** — the subtle one:

```ts
test("PricingEngine_purityBeforeAdjustment_appliesFullMarginOn22K", () => {
  // IBJA 999 ₹153,727/10g, +₹50/g margin, 916 purity, nearest ₹1.
  // Correct:  (1_537_270_000 × 916/1000) + 5_000_000 = 1_413_139_320 → ₹1,41,314.00
  // Inverted: (1_537_270_000 + 5_000_000) × 916/1000               → ₹1,41,272.00
  //           ← ₹42 per 10 g short; the ₹50/g margin becomes ₹45.80/g
  expect(result.rate_display_paise).toBe(14_131_400n);
});
```

This test exists to fail loudly if anyone reorders the pipeline. The comment records why the number is what
it is, so a future reader cannot "fix" it by matching the implementation.

**End-to-end scenario:** the two brief tenants against one market rate, asserting both computed rates and that
neither depends on the other's rule.

---

## 3. Realtime and provider failure

Driven through a controllable `MockMarketDataProvider` exposing `emit_rate()`, `fail_next(n)`,
`go_silent()`, and `disconnect()` — so failure paths are deterministic rather than timing-dependent.

| Test | Asserts |
|---|---|
| `Realtime_marketTick_pushesToSubscribedTenantOnly` | A's stream receives; B's does not |
| `Realtime_ruleChange_pushesToOwningTenantOnly` | Rule edits fan out to one tenant |
| `Realtime_twoTenantsOneTick_eachReceivesOwnRate` | Correct per-tenant values, no crossover |
| `MarketData_providerTimeout_servesLastKnownRateMarkedStale` | Serves cached, `freshness: "stale"` |
| `MarketData_providerSilent_transitionsLiveToDelayedToStale` | Threshold transitions in order |
| `MarketData_repeatedFailures_opensCircuitBreaker` | Opens at threshold, stops calling |
| `MarketData_providerRecovers_closesCircuitAndResumesLive` | Half-open → closed, `freshness: "live"` |
| `MarketData_retries_useExponentialBackoffWithJitter` | Intervals within jitter bounds, ≤3 retries |
| `MarketData_implausibleTick_isRejectedAndNotPublished` | Sanity check holds; last good rate retained |
| `SSE_connectionDropped_clientReconnectsWithLastEventId` | Resumes without a page reload |
| `SSE_multipleReplicas_eachRelaysOnlyItsOwnClients` | Redis fan-out correctness |

The stale-transition tests use a **fake clock**, not real delays — per rule 5, no hard waits.

`MarketData_implausibleTick_isRejectedAndNotPublished` guards a real failure mode: vendors do emit zeroes and
decimal-shifted values, and publishing one to a jeweller's customers is a commercial incident.

---

## 4. Authentication

Valid token → 200. Expired, malformed, wrong-signature, wrong-issuer, wrong-audience, and absent tokens → 401.
Token for a user with no tenant → 403. `staff` attempting an owner-only action → 403. Suspended tenant →
dashboard read-only, public page 404.

Explicitly tested: **permission is checked before existence**, so probing a nonexistent resource in another
tenant and an existing one both return 403 — the response cannot be used to enumerate what exists.

Rate limiting: login brute-force returns 429 with `Retry-After`; public rate endpoints limit by IP.

---

## 5. Public page

Beyond the isolation cases: the response contains no `tenant_id`, no internal user id, no
`adjustment_display_paise` when `show_base_rate` is false, no pricing rule ids, and no audit data. Asserted as an
**exact key-set comparison** against the allowlisted DTO shape, so a newly added column fails the test rather
than leaking quietly.

Also: disabled products are absent; display order is honoured; a revoked slug returns 410; an unknown slug
returns 404 without confirming whether it ever existed.

---

## 6. E2E (Playwright)

Few by design — rule 13. `storageState` reuses login; Page Object Model separates flows from selectors.

1. `@smoke` Shopkeeper signs up → onboards firm → lands on dashboard
2. `@smoke` Shopkeeper sets gold adjustment → preview reflects it → public page shows the new rate
3. `@smoke` Customer opens public link → sees branding and rates → no dashboard affordance
4. `@regression` Rate updates live in an open customer tab with no reload
5. `@regression` Two browser contexts on two tenants' links show independently correct rates
6. `@regression` Provider goes stale → customer page shows the stale badge, not a live one
7. `@regression` Logo upload rejects SVG, oversized files, and a `.png` that is not really a PNG

Mobile viewport is the default project for customer-page tests — it is the primary customer experience.

---

## 7. Commands

| Command | Scope |
|---|---|
| `npm test` | Unit — fast, no containers |
| `npm run test:integration` | Testcontainers: Postgres + Redis |
| `npm run test:isolation` | **Tenant isolation suite alone** |
| `npm run test:e2e` | Playwright |
| `npm run test:coverage` | Coverage with CI thresholds |

CI runs unit → integration → E2E, failing fast. `test:isolation` also runs as a **required standalone gate**,
so an isolation failure is never buried in an unrelated red build.
