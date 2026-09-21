import type { PublicRate } from "@bullion/contracts";
import { FreshnessBadge } from "./FreshnessBadge";
import { format_adjustment, format_rupees, format_unit, humanise_product_key } from "@/lib/money";
import styles from "./RateCard.module.css";

/**
 * One product's rate.
 *
 * Every number rendered here arrives from the server. The breakdown shows
 * `market_rate`, `shop_adjustment` and `rounding` **as sent**; the adjustment
 * is in particular never recovered as `rate - market_rate`, which would be off
 * by the rounding delta and would silently contradict what the shopkeeper
 * actually configured.
 *
 * The breakdown appears only when the shop published it. `market_rate === null`
 * means withheld, and the components are then absent from the payload
 * altogether rather than hidden with CSS.
 */
export function RateCard({
  rate,
  updated,
}: {
  rate: PublicRate;
  /** Set briefly after a live update, to draw the eye to what changed. */
  updated?: boolean;
}) {
  const label = rate.label !== "" ? rate.label : humanise_product_key(rate.product_key);
  const shows_breakdown = rate.market_rate !== null;
  const is_expired = rate.freshness === "expired";

  return (
    <article
      className={`${styles.card} ${updated === true ? styles.updated : ""}`}
      aria-labelledby={`rate-${rate.product_key}-label`}
    >
      <header className={styles.header}>
        <h3 className={styles.label} id={`rate-${rate.product_key}-label`}>
          {label}
        </h3>
        <FreshnessBadge freshness={rate.freshness} />
      </header>

      <p className={`${styles.amount} ${is_expired ? styles.amountExpired : ""}`}>
        <span className={styles.value}>{format_rupees(rate.rate)}</span>
        <span className={styles.unit}>{format_unit(rate.display_unit)}</span>
      </p>

      {is_expired ? (
        <p className={styles.expiredNote} role="note">
          This rate is too old to rely on. Please confirm with the shop before
          trading.
        </p>
      ) : null}

      {shows_breakdown ? (
        <dl className={styles.breakdown}>
          <div className={styles.row}>
            <dt>Market rate</dt>
            <dd>{format_rupees(rate.market_rate)}</dd>
          </div>
          <div className={styles.row}>
            <dt>Shop adjustment</dt>
            {/* The authored value, signed. Not derived from the two around it. */}
            <dd>{format_adjustment(rate.shop_adjustment)}</dd>
          </div>
          {rate.rounding !== null && rate.rounding !== "0" ? (
            <div className={styles.row}>
              <dt>Rounding</dt>
              <dd>{format_adjustment(rate.rounding)}</dd>
            </div>
          ) : null}
          <div className={`${styles.row} ${styles.total}`}>
            <dt>You pay</dt>
            <dd>{format_rupees(rate.rate)}</dd>
          </div>
        </dl>
      ) : null}

      <footer className={styles.footer}>
        <span className={styles.timestamp}>
          Updated{" "}
          <time dateTime={rate.source_timestamp}>
            {format_time(rate.source_timestamp)}
          </time>
        </span>
      </footer>
    </article>
  );
}

/**
 * Render the provider's timestamp as a local wall-clock time.
 *
 * Deliberately absolute rather than "2 minutes ago": a relative label computed
 * once on the server goes wrong the moment the page sits open, and this string
 * is the customer's evidence of *when* the price was true.
 */
export function format_time(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "at an unknown time";

  return at.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
