# Market Data Provider Evaluation

Research conducted 2026-09-20. Prices and terms change — **re-verify licensing in writing with the vendor
before signing.** Nothing here is legal advice.

---

## 1. The finding that drives everything

> **No provider is simultaneously cheap, streaming, and licensed to redistribute to your tenants' customers.**

This product shows market-derived rates to the general public — the walk-in customers of jewellery shops who
have no relationship with the data vendor. In market-data licensing terms that is **redistribution to third
parties**, and it is the single most commonly prohibited use in the cheap end of this market.

Most teams building this discover the problem after launch, via a cease-and-desist. Hence this document.

### What the evaluation actually eliminated

| Provider | Disqualifying finding |
|---|---|
| **fastFOREX** | Terms state plainly: *"You must not redistribute information displayed on or provided by fastFOREX."* Has excellent WebSocket metals coverage. Cannot be used. |
| **Twelve Data** (Individual) | Individual plans are for *"personal, internal, and non-commercial purposes."* $29–329/mo tiers are unusable; a Business plan is a separate negotiation. |
| **TrueData** (standard) | *"shall not be shared, transmitted, redistributed, displayed, or otherwise made available to any third party."* Requires a direct MCX redistributor agreement to be viable. |
| All free tiers | Uniformly internal/non-commercial — see §4. |

---

## 2. Comparison

| | **MetalpriceAPI** | **goldprice.dev** | **IBJA Official** | **TraderMade** | **MCX via vendor** |
|---|---|---|---|---|---|
| **Cost** | $32–132/mo | $30/mo Pro, $80 Realtime | On request | £599/mo | ₹1.5L/yr link + variable |
| **Update rate** | 60s / 30s / 15s by tier | ~60s; ticks on Realtime | 2×/day (AM, PM) | Live tick | Live tick |
| **Streaming** | ✗ REST poll | ✓ on $80 tier | ✗ | ✓ WebSocket | ✓ WebSocket |
| **Redistribution** | ⚠️ ambiguous | ⚠️ commercial w/ attribution | ✓ licensed for this | Enterprise only | Formal agreement |
| **INR** | ✓ | ✓ | Native | ✓ | Native |
| **Indian relevance** | Converted spot | Converted spot | **Benchmark** | Converted spot | **Benchmark** |
| **Verdict** | ⛔ **Blocked (B1)** | ⚠️ Candidate (B2, B3) | ⚠️ Anchor (B4) | Later | At scale |

⛔ blocked · ⚠️ candidate pending written confirmation. **Only `mock` is approved for use today** — see §3.1.

### MetalpriceAPI — ⛔ BLOCKED pending written confirmation

> **PRODUCTION BLOCKER — not approved for production use.**
> Written confirmation from MetalpriceAPI that our **multi-tenant, customer-facing display and
> redistribution** model is permitted must be obtained and filed before this provider is configured in
> production. Until then, `metalprice_api` may be used in development against a trial key only.

Their terms contain two clauses that are in tension, and the restrictive one is the general rule:

> *"The reproduction, duplication, copying, sale, resale, or exploitation of any aspect of this Application
> and its Services, and/or Data is strictly forbidden without the explicit written consent."*

> *"Subscribers are granted the right to display MetalpriceAPI's data on their websites for both commercial
> and personal projects, provided they hold an active subscription."*

The display grant plausibly covers *our* website. It is **not clear that it covers our tenants' branded
customer pages**, which is arguably redistribution to third parties — the thing the first clause forbids
absent written consent. A permissive reading is a commercial risk, not a legal position.

**Required before production:** written confirmation, from MetalpriceAPI, naming (a) display on pages branded
for our business customers, (b) an unbounded anonymous end-viewer audience, (c) server-side caching and
fan-out of their data to those viewers. Anything short of that keeps this blocker open.

Also note the cancellation tail: on lapse, previously fetched data may not be used commercially — so cached
rates must be purged if the subscription ends. Operational requirement, not a footnote.

No WebSocket. The backend polls; customers still get push via our own SSE layer, so the customer experience is
unaffected. Tiers: $32/mo for 60s refresh, $74/mo for 15s.

### goldprice.dev — candidate, same confirmation required

Retained as a candidate. Detail as published at the date of this review:

| Aspect | Free | **Pro — $30/mo** | **Realtime Pro — $80/mo** |
|---|---|---|---|
| Commercial display rights | ✗ *"for internal use"* | ✓ *"Commercial use with attribution"* | ✓ same |
| Attribution required | n/a | **Yes** | **Yes** |
| WebSocket | ✗ | ✗ | ✓ *"WebSocket ticks for XAU, XAG, HG"* |
| Update cadence | ~60s | ~60s | Tick |
| Call quota | 1,000/mo, 30/min | 20,000/mo | Higher tiers to 1,000,000/mo |
| API key | Not required | Required | Required |

**XAU/XAG coverage.** XAU (gold) is the primary product, quoted in 31 currencies **including INR**. XAG
(silver) is covered, and WebSocket ticks on Realtime Pro are documented for XAU, XAG and HG (copper). Both
metals this product needs are therefore available; **verify XAG/INR specifically**, since INR coverage is
documented at the currency level rather than per instrument.

**Does it permit our exact use case? Not yet established.** "Commercial use with attribution" is materially
more permissive than MetalpriceAPI's wording, and it is the closest fit found. But *commercial use* and
*redistribution to an unbounded third-party audience through multi-tenant branded pages* are not the same
claim, and the published tier description does not address multi-tenancy. **The same written confirmation
required of MetalpriceAPI is required here** before production use. Treat as a candidate, not an approval.

**Attribution is a product constraint, not just a legal one.** Pro and Realtime Pro both require visible
attribution — a "Spot data by goldprice.dev" line on every jeweller's customer page. Confirm your jewellers
accept third-party branding on their rate board before committing; some will not.

**Quota fit.** 20,000 calls/mo against ~21,750 one-minute polls during market hours
(`25 days × 14.5 h × 60`) is a genuine overrun. Either throttle to ~70s, restrict hours further, or size up a
tier. Do not plan on exactly 60s at the Pro tier.

### IBJA Official API — the benchmark anchor

IBJA is *the* reference for gold valuation in India; banks price gold loans off it. Covers 999/995/916/750/585
plus silver 999, AM and PM.

> *"Any party using the IBJA Gold Price for valuation and pricing activities... are advised to subscribe IBJA
> rates only through OFFICIAL IBJA API."*

This licensing posture is the opposite of the others — it *expects* downstream pricing use, which is exactly
our case. Only two fixes a day, so it cannot carry intraday movement alone. Pricing is not public; contact
`nagaraj.iyer@ibja.in` / `ankitawadke@ibja.in`.

**Do not use the unofficial IBJA scrapers on GitHub.** They are unlicensed, they break when the site changes,
and IBJA's notice above directly addresses them. Unacceptable for a product that prices real transactions.

### TraderMade — the upgrade path

£599/mo covers all FX and crypto pairs with REST + WebSocket and permits business use, but **white-label and
redistribution rights are Enterprise-only**. At pre-revenue this is hard to justify; revisit at scale. They
run a startup programme worth asking about.

### MCX via authorised vendor — the endgame

MCX gold and silver futures are what the Indian trade actually watches intraday. MCX operates a genuine
redistribution framework: sign a redistribution agreement, report your subscriber list quarterly, pay
~₹1.5L/yr in link charges plus variable tariffs. Redistributors may disseminate to *their own clients*, so
tenant structure needs legal review against that definition.

Correct destination for a serious Indian bullion product. Wrong starting point — the compliance overhead
exceeds a pre-revenue build.

---

## 3. Recommendation

**Development (now): `MARKET_DATA_PROVIDER=mock`.** Zero cost, zero licensing, full realtime development.
This is the only provider approved for use today.

**Launch: blocked on written licensing confirmation.** goldprice.dev Pro and MetalpriceAPI are both
*candidates* for the spot component, and IBJA Official is the benchmark anchor. None is production-approved
until the redistribution question in §3.1 is answered in writing.

**Scale: MCX redistributor agreement** once revenue supports the compliance overhead.

### 3.1 Open production blockers

| # | Blocker | Owner | Blocks |
|---|---|---|---|
| **B1** | **MetalpriceAPI**: written confirmation that multi-tenant customer-facing display/redistribution is permitted | Procurement | `metalprice_api` in production |
| **B2** | **goldprice.dev**: same written confirmation, plus XAG/INR availability check and Pro-tier quota sizing | Procurement | `goldprice_dev` in production |
| **B3** | **goldprice.dev**: confirm jewellers accept mandatory third-party attribution on their rate pages | Product | `goldprice_dev` in production |
| **B4** | **IBJA Official**: obtain pricing and licence terms (`nagaraj.iyer@ibja.in`) | Procurement | `ibja` / `composite` in production |

None of these blocks development. The mock provider carries stages 1–12.

### 3.2 What the architecture does and does not do for cost

The leader-elected poller **decouples market-data consumption from browser and customer count** — provider
call volume follows the polling interval and market hours, not signups.

It does **not** make running costs flat. Our own infrastructure scales with tenants and concurrent
connections: SSE connections drive Container Apps replicas, Redis pub/sub throughput scales with subscribers,
and `rate_update_events`, `audit_logs`, and logo storage grow with tenants over time. See
[ARCHITECTURE.md](../ARCHITECTURE.md) §6.

---

## 4. Free tiers: why none of them work

Asked and checked directly. Two independent blockers:

**Licensing.** goldprice.dev free is *"for internal use"*; MetalpriceAPI free is *"solely for personal
exploration and evaluation... must not be used for any commercial activities"*; metals.dev free is 100
requests/month. Showing rates to a jeweller's customers is neither internal nor personal.

**Volume.** One poll a minute during market hours is ~21,750 calls/month. Free tiers offer 100–1,000. Short
by 20–200×, before licensing even enters the discussion.

`gold-api.com` advertises free unrestricted access but is USD-only with no INR and unverified terms — usable
as a free cross-check signal to detect bad ticks, never as a source of record.

**The mock provider is the real answer to "is there a free option":** it costs nothing, and it lets every
realtime feature be built and tested before a rupee is spent.

---

## 5. Provider abstraction

One interface; the choice above becomes a config value, not an architectural commitment.

```ts
export interface MarketDataProvider {
  readonly name: string;
  get_latest_rates(symbols: Symbol[]): Promise<MarketRate[]>;
  subscribe_to_live_rates(
    symbols: Symbol[],
    on_rate: (rate: MarketRate) => void,
  ): Promise<Subscription>;
  health_check(): Promise<ProviderHealth>;
}
```

`MarketRate` normalises every provider to the same shape — `bid`/`ask`/`mid` as **integer paise per gram**,
`provider_timestamp`, `source`, `symbol` — so the pricing engine never learns which vendor it came from.
Polling providers implement `subscribe_to_live_rates` as an internal interval that invokes the same callback,
making the streaming distinction invisible above the adapter.

Implementations: `MockMarketDataProvider` (dev), `GoldPriceDevProvider`, `MetalpriceApiProvider`,
`IbjaProvider`, and later `McxProvider`. A `CompositeProvider` layers IBJA fixes with spot movement, which is
the selected production configuration.

---

## Sources

- [MetalpriceAPI pricing](https://metalpriceapi.com/pricing) · [terms](https://metalpriceapi.com/terms)
- [goldprice.dev](https://goldprice.dev/)
- [IBJA official rates API](https://www.indiagoldratesapi.com/) · [IBJA](https://www.ibja.co/)
- [TraderMade pricing](https://tradermade.com/pricing)
- [Twelve Data pricing](https://twelvedata.com/pricing)
- [fastFOREX metals](https://www.fastforex.io/hub/realtime-gold-api-silver-and-base-metals-live)
- [MCX data feed](https://www.mcxindia.com/technology/datafeed/data-feed-product-and-charges) ·
  [TrueData](https://www.truedata.in/products/marketdataapi)
- [metals.dev](https://metals.dev/) · [gold-api.com](https://gold-api.com/)
