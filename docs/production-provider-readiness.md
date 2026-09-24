# Production provider readiness

**No provider is approved.** Every entry in `MARKET_DATA_PROVIDERS` other than
`mock` is listed in `PRODUCTION_BLOCKED_PROVIDERS`, and `mock` is refused in
production outright. Nothing in this document approves anything; it states what
a provider must satisfy before it *can* be approved, and what must be true of
our own code before a provider is worth onboarding.

Approval requires **written** redistribution and customer-display rights on
file. See §1. A provider's marketing page, a forum answer, or an absence of
prohibition in the terms is not evidence.

---

## 0. What must exist on our side first

**Built in Stage 10.** The publication pipeline that was missing — poller,
leader election, recompute, `published_rates` write, durable outbox and Redis
delivery — now exists and is exercised end to end against real PostgreSQL and
Redis. `ARCHITECTURE.md` §13's claim that onboarding a provider means "one
module changes" is now accurate.

What remains for a new provider is genuinely one adapter:

1. Implement `MarketDataProvider` (`start`, `stop`, `get_latest_quotes`,
   `subscribe`, `on_status`, `health`) emitting **raw payloads**. Do not
   construct `MarketQuote` directly — `parse_quote` must validate vendor data on
   the same path as every other source.
2. Add one branch to `create_provider` in `modules/publication/pipeline.ts`.
3. Set the configuration in §9 below.

Nothing else changes. The poller, pricing, publication, outbox, Redis, SSE and
the frontend all consume the abstraction rather than the vendor.

Two notes carried over from the Stage 9 audit that are still true:

- **Freshness defaults assume a ~60s feed.** `FRESHNESS_STALE_AFTER_MS` (120s)
  and `FRESHNESS_EXPIRED_AFTER_MS` (600s) must be set from the provider's real
  cadence. For a twice-daily source such as IBJA every quote would be `expired`
  within ten minutes and **nothing would ever be published**, because the
  pipeline refuses to publish from an expired quote.
- **The sanity limit rejects large jumps.** `MARKET_RATE_SANITY_MAX_MOVE_BPS`
  defaults to 500 bps. A provider whose first quote after a gap legitimately
  moves more than 5% will have it rejected as an implausible tick.

## 1. Licensing — the blocking gate

Required in writing, from someone able to bind the provider commercially:

- [ ] **Redistribution right.** We may transmit their prices to our customers'
      customers (the jeweller's walk-in and WhatsApp audience), not merely use
      them internally.
- [ ] **Customer display right.** Their data may be displayed on a public,
      unauthenticated web page.
- [ ] **Derived-value right.** We publish a *derived* number — their rate plus
      the shop's adjustment, converted for purity. Confirm that publishing a
      derived price is permitted, and whether the underlying rate may also be
      shown (our `show_base_rate` disclosure depends on this).
- [ ] **Sub-licensing to tenants.** Each jeweller is a separate business. Confirm
      whether one licence covers all tenants or whether each needs its own.
- [ ] **Attribution.** Exact wording and placement required, if any. The public
      page must carry it — there is currently no attribution slot in
      `PublicShop`, so this may need a schema field.
- [ ] **Territory.** India specifically.
- [ ] **Termination.** Notice period, and what we must do with cached rates on
      termination.
- [ ] **Audit rights.** Whether they may audit our usage, and what we must retain.

> `docs/market-data-providers.md` records that fastFOREX prohibits
> redistribution outright. Treat every provider as prohibited until proven
> otherwise in writing.

---

## 2. Symbols and instruments

- [ ] Exact symbol strings for gold and silver in INR.
- [ ] Whether they quote `XAU`/`XAG` (troy-ounce metal codes) or an INR-direct
      instrument such as `XAUINR`.
- [ ] If only `XAUUSD` plus a USD/INR rate: **this is two providers, not one.**
      Our `MarketQuote` carries a single `source_timestamp`, and a cross-rate
      composed from two feeds with different timestamps has no single honest
      one. Decide explicitly which timestamp is published, and document it.
- [ ] Whether the same symbol can change meaning (contract rollover on MCX).
- [ ] Reference purity of the quote. IBJA quotes 999; the code models this as
      `MarketQuote.purity` and the pricing engine converts from it. A provider
      quoting 995 or unrefined metal must be stated, not assumed.

Our `MetalCode` is `"GOLD" | "SILVER"` and `CurrencyCode` is `"INR"` only. A
provider that cannot ultimately yield INR requires a currency-conversion
component that does not exist.

---

## 3. Units, precision and conversion

Canonical internal unit: **integer milli-paise per gram** (`RATE_SCALE = 1000`,
ADR-0003). `SourceQuoteUnit` already models `per_gram`, `per_10_gram`,
`per_kilogram`, `per_troy_ounce`.

- [ ] Quoted unit, exactly. Per troy ounce, per 10g, per kg?
- [ ] **Troy ounce definition.** If quoting per troy ounce, the conversion
      constant must be agreed: 1 troy oz = 31.1034768 g exactly. This is an
      irrational-looking decimal and the conversion **must** be done as exact
      rational arithmetic, never floating point. Confirm the provider uses the
      standard definition and not a rounded 31.1035.
- [ ] Decimal places supplied, and whether trailing precision is significant.
- [ ] Whether values arrive as JSON **numbers**. If so, they are IEEE-754
      doubles and have already lost exactness before we see them — the adapter
      must read them from the raw response body as strings, or the provider must
      offer a string-typed field.
- [ ] Whether prices can be negative or zero (they should not be; the schema
      should reject).
- [ ] Maximum plausible value, for the sanity check
      (`MARKET_RATE_SANITY_MAX_MOVE_BPS`, default 500 bps).

---

## 4. Timestamps

Our model separates `source_timestamp` (the vendor's stamp, shown to customers)
from `received_at` (when we saw it, never shown). A provider that does not
supply its own timestamp breaks the freshness model.

- [ ] Does every quote carry a provider-assigned timestamp?
- [ ] Timezone and format. IST or UTC? ISO 8601 or epoch?
- [ ] Epoch **units** — seconds or milliseconds. A seconds value read as
      milliseconds dates the quote to 1970 and it is immediately `expired`;
      the reverse marks a year-old quote as fresh.
- [ ] Is the timestamp the exchange's, the vendor's ingestion time, or the
      response time? Only the first is a market timestamp.
- [ ] Clock skew: acceptable tolerance for a timestamp slightly in the future.
      `classify_age` already treats negative age as `fresh` deliberately.
- [ ] Does the timestamp advance when the price does not? A feed that restamps
      an unchanged price hides staleness; one that does not restamp makes an
      unchanged market look stale.
- [ ] Sequence numbers, if any → `MarketQuote.sequence`, used to order updates
      when timestamps tie.

---

## 5. Delivery, reconnect and limits

- [ ] Transport: WebSocket push, SSE, or REST polling.
- [ ] If polling: minimum permitted interval, and whether it is enforced or
      merely requested.
- [ ] Rate limits: requests per minute/day, and behaviour on breach (429, ban,
      billing).
- [ ] Concurrent connection limit. Relevant because the poller is leader-elected
      and should hold exactly one.
- [ ] Reconnect expectations: backoff they require, whether rapid reconnect is
      penalised. Ours is full-jitter capped at 30s (`DEFAULT_BACKOFF`).
- [ ] Heartbeat/keepalive semantics, and how a dead-but-open socket is detected.
- [ ] Replay on reconnect: do we receive missed ticks or only the next one?
- [ ] Duplicate delivery: can the same quote arrive twice? `QuoteStream` already
      rejects `duplicate` and `out_of_order`, but the dedupe key must match what
      the provider guarantees is unique.
- [ ] Out-of-order delivery: possible?
- [ ] Market hours, and what is sent outside them. `MARKET_HOURS_IST` defaults to
      `09:00-23:30`. A feed that goes silent overnight will age into `expired` —
      confirm this is the intended customer-visible behaviour, because the page
      will then say "out of date" until morning.
- [ ] Scheduled maintenance windows.
- [ ] Status page / incident notification channel.

---

## 6. Failure behaviour

- [ ] HTTP status codes and error body shape for: auth failure, rate limit,
      unknown symbol, internal error.
- [ ] Whether a failure can return HTTP 200 with an error body — this is common
      and would otherwise be parsed as a quote.
- [ ] Whether stale data is served silently during their own outages.
- [ ] Whether prices are ever restated or corrected after publication.

---

## 7. Commercial

- [ ] Price, and what the metered unit is (requests, symbols, MAU, connections).
- [ ] Expected monthly usage under our poll interval. At the default 60s poll,
      one leader, two symbols: ~86,400 requests/month.
- [ ] Overage behaviour: throttle or bill.
- [ ] SLA and support channel, with response times.
- [ ] Notice period for breaking API changes.
- [ ] Sandbox/test credentials, so the adapter can be built and tested before
      committing.

---

## 8. Acceptance tests before switching production

Once licensed, the adapter must demonstrate all of the following against the
real feed, on a non-production deployment:

1. A quote round-trips to `published_rates` with the value verifiable by hand
   against the provider's own published number.
2. `source_timestamp` matches the provider's stamp, not our receipt time.
3. A deliberately malformed payload is rejected and counted, not published.
4. Killing the connection produces `disconnected`, then reconnect, with no
   fabricated quote in between.
5. Withholding quotes drives `fresh → stale → expired` on the public page, and
   the page visibly stops presenting the rate as usable.
6. A duplicate and an out-of-order quote are both rejected with the right
   `RejectionReason`.
7. Sustained running for at least one full market session without leaking
   memory or connections.
8. `MARKET_DATA_LICENCE_CONFIRMED` is set **only** once the written evidence in
   §1 is filed, and the file is referenced in the deploy record.

---

## 9. Configuration this will require

| Variable | Notes |
|---|---|
| `MARKET_DATA_PROVIDER` | Must not be `mock`; production refuses it. |
| `MARKET_DATA_API_KEY` | Key Vault only. Never a `NEXT_PUBLIC_` value. |
| `IBJA_API_KEY` | Additionally required for `ibja` and `composite`. |
| `MARKET_DATA_LICENCE_CONFIRMED` | The escape hatch for a licence-blocked provider. Setting it without the §1 evidence defeats the entire control. |
| `MARKET_POLL_INTERVAL_MS` | Must respect §5 rate limits. |
| `FRESHNESS_STALE_AFTER_MS` / `FRESHNESS_EXPIRED_AFTER_MS` | Must be set from the provider's real update cadence. The defaults (120s / 600s) assume a ~60s feed and are wrong for a twice-daily fix such as IBJA. |
| `MARKET_RATE_SANITY_MAX_MOVE_BPS` | Tune to the instrument's real volatility. |
