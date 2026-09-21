"use client";

import { useMemo } from "react";
import type { PublicRate } from "@bullion/contracts";
import { RateCard } from "./RateCard";
import { ConnectionNotice } from "./ConnectionNotice";
import { useRateStream } from "@/lib/useRateStream";
import styles from "./LiveRates.module.css";

/**
 * The rate board: server-rendered prices, then live corrections.
 *
 * The initial rates come from the server so the first paint already shows a
 * price — a customer opening a shop's link on mobile data should not meet a
 * spinner. The stream then supersedes individual products as they change.
 *
 * ## Merging
 *
 * A live event carries a rate and its freshness, not a whole product. It is
 * applied on top of the server's row for that `product_key`, so the label,
 * unit and the shop's breakdown disclosure all survive an update.
 *
 * The breakdown components are **cleared** when a live rate arrives, because
 * the event does not carry them. Keeping the old `market_rate` beside a new
 * `rate` would render a breakdown whose parts no longer correspond to its
 * total — the page would be quietly lying. Showing only the authoritative new
 * rate is the honest option, and the next full fetch restores the detail.
 */
export function LiveRates({
  initial_rates,
  stream_url,
  create_source,
}: {
  initial_rates: readonly PublicRate[];
  stream_url: string | null;
  create_source?: (url: string) => EventSource;
}) {
  const stream = useRateStream({
    url: stream_url,
    ...(create_source === undefined ? {} : { create_source }),
  });

  const rates = useMemo(() => {
    return initial_rates.map((rate) => {
      const update = stream.updates.get(rate.product_key);
      if (update === undefined) return rate;

      return {
        ...rate,
        rate: update.rate_display_paise,
        display_unit: update.display_unit,
        source_timestamp: update.source_timestamp,
        freshness: update.freshness,
        // Withheld rather than stale: see the note above.
        market_rate: null,
        shop_adjustment: null,
        rounding: null,
      } satisfies PublicRate;
    });
  }, [initial_rates, stream.updates]);

  if (rates.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <p className={styles.emptyTitle}>No rates published yet</p>
        <p className={styles.emptyBody}>
          This shop has not published any rates. Please check back shortly or
          contact them directly.
        </p>
      </div>
    );
  }

  return (
    <>
      <ConnectionNotice state={stream.state} />

      {/* Updates are announced politely so a screen reader is not interrupted
          mid-sentence every time a rate ticks. */}
      <div aria-live="polite" aria-atomic="false" className="visually-hidden">
        {stream.last_changed.length > 0
          ? `Rate updated for ${stream.last_changed.join(", ")}`
          : ""}
      </div>

      <ul className={styles.grid}>
        {rates.map((rate) => (
          <li key={rate.product_key}>
            <RateCard
              rate={rate}
              updated={stream.last_changed.includes(rate.product_key)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
