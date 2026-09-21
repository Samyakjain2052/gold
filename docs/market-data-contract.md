# Market Data Contract

The vendor-independent contract between a market-data provider and everything
downstream of it. No type, field or behaviour here names a vendor.

Implemented in [`apps/api/src/modules/market_data/`](../apps/api/src/modules/market_data/).
Provider selection and licensing status: [market-data-providers.md](market-data-providers.md).

---

## 1. Quote schema

A normalised `MarketQuote`. Money is **integer milli-paise per gram**
([ADR-0003](adr/0003-integer-paise-per-gram.md)) — no JavaScript `number`
carries a monetary value at any point.

| Field | Type | Notes |
|---|---|---|
| `quote_id` | `string` | Provider's id, or synthesised as `provider:symbol:timestamp` |
| `sequence` | `number \| null` | Provider sequence where the feed supplies one |
| `provider` | `string` | Opaque identifier — `mock`, `goldprice_dev`, … |
| `source` | `ibja \| spot \| mcx \| mock` | Origin class |
| `symbol` | `string` | `XAU_INR`, `XAG_INR` |
| `metal` | `GOLD \| SILVER` | |
| `currency` | `INR` | |
| `unit` | `per_gram` | Unit of `bid`/`ask`/`mid`. Always canonical. |
| `source_unit` | `per_gram \| per_10_gram \| per_kilogram \| per_troy_ounce` | What the vendor quoted, kept for traceability |
| `purity` | `{ num, den }` | Reference fineness. IBJA quotes 999. |
| `bid` | `bigint \| null` | Nullable — not every source quotes two-way |
| `ask` | `bigint \| null` | |
| `mid` | `bigint` | Always present. What pricing consumes. |
| `source_timestamp` | `Date` | **The vendor's stamp. This is what customers see.** |
| `received_at` | `Date` | When this process saw it. Never shown as "last updated". |

### Why the two timestamps are separate

Conflating them is precisely how a system presents stale data as live. A
provider that reconnects and replays an hour-old quote has produced nothing
new; measuring age from our receipt time would claim otherwise. **Freshness is
always measured against `source_timestamp`.**

### Why freshness is not a field

Freshness changes as time passes without the quote changing at all. Storing it
on the quote would let a stale value be served carrying a `fresh` label baked in
at write time. It is computed at read time into a `QuoteSnapshot`:

```ts
interface QuoteSnapshot {
  quote: MarketQuote;
  freshness: "fresh" | "stale" | "expired";
  age_ms: number;
  evaluated_at: Date;
}
```

### Validation

Raw payloads pass `parse_quote` before anything else touches them
(`api-standards.md` §9). Rejected: missing or non-numeric `mid`, `mid <= 0`,
unknown metal/source/currency, malformed timestamps, purity above 100% fine, and
**crossed quotes** (`bid > ask`). Amounts are parsed by the money module's
string parser, never `parseFloat`.

Error messages never echo the raw payload — a vendor response can carry
credentials, and those must not reach a log line.

---

## 2. Freshness policy

Three states, two thresholds.

| State | Condition | Meaning | Customer-facing |
|---|---|---|---|
| `fresh` | `age ≤ stale_after_ms` | Within the expected cadence | Shown as live |
| `stale` | `age ≤ expired_after_ms` | Link may be fine; data has aged | Shown, explicitly marked stale |
| `expired` | otherwise | Too old to price against | Not shown; pricing refuses |

### Where the defaults come from

Derived from the polling interval, not picked for roundness:

- **`FRESHNESS_STALE_AFTER_MS` = 120 000 (2 min)** — twice the 60 s default poll
  interval plus margin. One missed poll is normal jitter; two consecutive misses
  is a signal. Below the poll interval this would flap every cycle; far above it
  would hide a dead feed.
- **`FRESHNESS_EXPIRED_AFTER_MS` = 600 000 (10 min)** — ten missed polls. Gold
  moves materially in ten minutes, so a rate this old must not underpin a price
  a jeweller would honour at the counter.

Both are configurable. A deployment polling IBJA's twice-daily fix needs far
larger values; one on a streaming feed needs smaller. Startup validation rejects
`stale ≥ expired`, since that would make the `stale` state unreachable.

A **negative age** (vendor clock ahead of ours) classifies as `fresh`. Small
skew between hosts is normal, and refusing data over it would take the feed down
for a non-problem.

### When data ages

The last known quote is **retained**, marked, and still exposed with both
timestamps. It is never discarded and never relabelled as live.

### When data expires

`resolve_base_rate` returns a discriminated result, not a nullable quote:

```ts
type BaseRateResolution =
  | { available: true;  snapshot: QuoteSnapshot }
  | { available: false; reason: "no_quote" | "expired"; last_known: QuoteSnapshot | null };
```

A caller cannot accidentally treat "expired" as "fine". The last known snapshot
is still handed back — for display as an explicitly stale figure — but
`available: false` means **no new price may be published from it**. The pricing
layer does not extrapolate, interpolate or invent a rate.

---

## 3. Provider lifecycle

```
              ┌──────────────────┐
              │  not_configured  │   no provider selected for this deployment
              └────────┬─────────┘
                       │ construct
              ┌────────▼─────────┐
              │    configured    │   constructed, start() not yet called
              └────────┬─────────┘
                       │ start()
              ┌────────▼─────────┐
        ┌────▶│    connecting    │◀────────────┐
        │     └────────┬─────────┘             │ retry with backoff
        │              │ first accepted quote  │
        │     ┌────────▼─────────┐             │
        │     │     healthy      │             │
        │     └───┬──────────┬───┘             │
        │         │          │ age > stale_after_ms
        │         │     ┌────▼─────┐           │
        │         │     │  stale   │           │
        │         │     └────┬─────┘           │
        │         │          │ fresh quote     │
        │         │◀─────────┘                 │
        │         │ connection lost            │
        │    ┌────▼─────────┐                  │
        └────│ disconnected │──────────────────┘
             └────┬─────────┘
                  │ unrecoverable / start() failed
             ┌────▼─────┐        stop()      ┌──────────────┐
             │  error   │───────────────────▶│ disconnected │
             └──────────┘                    └──────────────┘
```

`stale` is reachable **only from `healthy`**: the link is up but the data has
aged. That is operationally different from `disconnected`, and collapsing the
two would hide a silently-frozen feed behind a green light. Transitions are
validated by `is_valid_transition`; an illegal one is recorded in `last_error`
rather than thrown, because a status path must never take the feed down.

### Interface

```ts
interface MarketDataProvider {
  readonly name: string;
  readonly source: MarketSource;
  readonly is_simulated: boolean;

  start(): Promise<void>;                                   // idempotent
  stop(): Promise<void>;                                    // idempotent, never throws
  get_latest_quotes(symbols: readonly string[]): Promise<unknown[]>;
  subscribe(listener: QuoteListener): Subscription;
  on_status(listener: StatusListener): Subscription;
  health(): ProviderHealth;
}
```

Providers emit **raw payloads**, not domain objects. Validation lives outside
the adapter so every provider is held to the same schema, and an adapter cannot
wave a malformed quote through by constructing the domain type directly.

### Reconnect behaviour

Reconnection is the provider's own responsibility. Callers never drive it; they
observe it through `health()` and the status listener.

Capped exponential backoff with **full jitter** (`api-standards.md` §9):

```
delay = random(0, min(30_000ms, 250ms × 2^attempt))
```

Full jitter rather than equal jitter because the failure being defended against
is every replica retrying in lockstep after a provider outage.

### Failure behaviour

A provider never throws from its subscription path. Failures surface as a status
transition plus `last_error`. The last known quote is retained and ages
naturally into `stale` then `expired`. **Nothing fabricates a quote to fill a
gap.**

---

## 4. Ingestion: duplicates, ordering, plausibility

A feed is not a clean sequence — reconnects replay, HTTP retries
double-deliver, streaming feeds interleave. Handled in `QuoteStream`, so every
adapter gets identical treatment and the rules are testable without a provider.

### Duplicate handling

A quote is a duplicate when its `quote_id` has been seen for that symbol, or
when it carries no newer sequence/timestamp than the last accepted quote.

Duplicates are **rejected, not re-published**. Re-publishing would refresh the
displayed timestamp with no new market information — exactly the faked
real-time this product must not do.

A bounded LRU of recent ids per symbol (`dedupe_window`, default 256) keeps a
long-running process from growing without limit.

### Out-of-order handling

Ordering uses `sequence` when the provider supplies one, `source_timestamp`
otherwise — a provider's own sequence is more reliable than its clock. A quote
older than the last accepted one is rejected; publishing it would move the board
backwards in time.

Equal timestamps with no sequence are treated as **duplicates** rather than
out-of-order: we cannot tell which came first, and re-publishing gains nothing.

### Plausibility

A move beyond `max_move_bps` (default 500 = 5%) from the last accepted mid is
rejected and the last known good quote retained. Vendors do emit zeroed and
decimal-shifted prices; publishing one to a jeweller's customers is a commercial
incident.

### Rejections are counted, never silent

`stats()` reports accepted plus a count per reason
(`invalid_schema`, `duplicate`, `out_of_order`, `implausible_move`,
`unknown_symbol`). A provider that silently drops malformed quotes hides a
broken feed.

---

## 5. Provider status vs application health

`/health/live` (liveness) never touches the provider: a dead feed must not cause
the orchestrator to restart otherwise-healthy replicas.

`/health/market-data` reports the provider's own status, and
`not_configured` while none is wired. It is **never** reported as `healthy` for
a component that does not exist.

`MarketDataService.health()` upgrades a nominally-`healthy` provider to `stale`
when every symbol has aged past the threshold. Without that the dashboard would
show a green provider beside a frozen board — the exact state in which stale
data looks live.

`not_configured` does not fail readiness: it means "not part of this build yet",
not "broken".

---

## 6. The mock provider

`MARKET_DATA_PROVIDER=mock`. Zero cost, no account, no licensing — the only
provider approved for use today ([blockers B1–B4](market-data-providers.md)).

It emits raw payloads on the same path a vendor would, so `parse_quote` and
`QuoteStream` are exercised rather than bypassed. All twelve required behaviours
are driven explicitly by the caller, never by wall-clock timing:

| # | Behaviour | Control |
|---|---|---|
| 1 | Normal updates | `tick()`, `tick_symbol(symbol, mid?)` |
| 2 | Multiple symbols/metals | Gold `per_10_gram` + silver `per_kilogram` by default |
| 3 | Bid/ask | Emitted around the mid at a configured half-spread |
| 4 | Source timestamps | Taken from the injected `Clock` |
| 5 | Disconnection | `disconnect(reason?)` |
| 6 | Reconnection | `reconnect()` → returns the backoff it would have used |
| 7 | Delayed/stale data | `emit_stale(symbol, age_ms)`, `go_silent()` / `resume()` |
| 8 | Malformed quotes | `emit_malformed(payload?)` |
| 9 | Duplicates | `emit_duplicate(symbol)` — replays the last payload verbatim |
| 10 | Out-of-order | `emit_out_of_order(symbol, age_ms?)` — lower sequence *and* older stamp |
| 11 | Graceful shutdown | `stop()` — releases listeners, settles on `disconnected` |
| 12 | Health transitions | `mark_stale()`, `mark_healthy()`, `fail_next(n)` |

Also `emit_implausible(symbol, multiplier)` for the plausibility band.

### Test-time control

Time comes from an injected `Clock`. Tests use `ManualClock` and call
`advance(ms)`, so a suite can step across the ten-minute expiry threshold
instantly and deterministically — `testing-best-practices.md` §5 forbids hard
waits, and a test that really waited ten minutes would never be run.

### Production safety

Two independent guards:

1. `is_simulated === true`, surfaced on `ProviderHealth`.
2. Startup configuration **refuses to boot** when
   `MARKET_DATA_PROVIDER=mock` and `NODE_ENV=production`.

Simulated prices cannot reach a real customer.
