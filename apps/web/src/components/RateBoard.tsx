"use client";

import { useState } from "react";
import type { PublicRate } from "@bullion/contracts";
import { FreshnessBadge } from "./FreshnessBadge";
import { format_adjustment, format_rupees, format_unit, humanise_product_key } from "@/lib/money";
import styles from "./RateBoard.module.css";

/**
 * The rate board.
 *
 * A jeweller's rates are read the way a departures board is read: several
 * products at once, from across a room or at a glance on a phone. A dense table
 * serves that far better than a column of cards, which forces scrolling to
 * compare two metals.
 *
 * It is a real `<table>`, not a grid of divs. The data is genuinely tabular —
 * product against price — so the semantics come free: a screen reader announces
 * "Gold 99.9, sell, ₹1,53,504.00" because the header cells say so.
 *
 * ## The breakdown is still the shop's choice
 *
 * Density must not cost disclosure. Where a shop publishes its market rate and
 * adjustment (`show_base_rate`), the row carries a toggle that reveals them.
 * Where it does not, the payload contains no components at all and no toggle is
 * rendered — the same rule the cards followed.
 *
 * Nothing here computes a price. Every figure is printed as the server sent it,
 * and the adjustment is the authored value, never `rate − market_rate`.
 */
export function RateBoard({
  rates,
  changed,
}: {
  rates: readonly PublicRate[];
  /** Product keys touched by the latest update, for a brief highlight. */
  changed?: readonly string[];
}) {
  const [open, set_open] = useState<ReadonlySet<string>>(new Set());

  function toggle(product_key: string): void {
    set_open((previous) => {
      const next = new Set(previous);
      if (next.has(product_key)) next.delete(product_key);
      else next.add(product_key);
      return next;
    });
  }

  return (
    <table className={styles.board}>
      <caption className="visually-hidden">
        Today&rsquo;s rates. Each row shows a product and the rate you pay.
      </caption>

      <thead>
        <tr className={styles.headRow}>
          <th scope="col" className={styles.headProduct}>
            Product
          </th>
          <th scope="col" className={styles.headRate}>
            Sell
          </th>
        </tr>
      </thead>

      <tbody>
        {rates.map((rate) => {
          const label = rate.label !== "" ? rate.label : humanise_product_key(rate.product_key);
          const shows_breakdown = rate.market_rate !== null;
          const is_open = open.has(rate.product_key);
          const is_expired = rate.freshness === "expired";
          const detail_id = `breakdown-${rate.product_key}`;

          return (
            <tr
              key={rate.product_key}
              className={`${styles.row} ${changed?.includes(rate.product_key) === true ? styles.updated : ""}`}
            >
              <th scope="row" className={styles.product}>
                <span className={styles.label}>{label}</span>

                <span className={styles.meta}>
                  <FreshnessBadge freshness={rate.freshness} className={styles.badge} />
                  <span className={styles.unit}>{format_unit(rate.display_unit)}</span>
                </span>

                {shows_breakdown ? (
                  <button
                    type="button"
                    className={styles.toggle}
                    aria-expanded={is_open}
                    aria-controls={detail_id}
                    onClick={() => toggle(rate.product_key)}
                  >
                    {is_open ? "Hide breakdown" : "Show breakdown"}
                  </button>
                ) : null}

                {shows_breakdown && is_open ? (
                  <dl className={styles.breakdown} id={detail_id}>
                    <div className={styles.line}>
                      <dt>Market rate</dt>
                      <dd>{format_rupees(rate.market_rate)}</dd>
                    </div>
                    <div className={styles.line}>
                      <dt>Shop adjustment</dt>
                      {/* The configured value, printed as sent. */}
                      <dd>{format_adjustment(rate.shop_adjustment)}</dd>
                    </div>
                    {rate.rounding !== null && rate.rounding !== "0" ? (
                      <div className={styles.line}>
                        <dt>Rounding</dt>
                        <dd>{format_adjustment(rate.rounding)}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}

                {is_expired ? (
                  <p className={styles.expired} role="note">
                    Too old to rely on — please confirm with the shop.
                  </p>
                ) : null}
              </th>

              <td className={`${styles.rate} ${is_expired ? styles.rateExpired : ""}`}>
                <span className={styles.amount}>{format_rupees(rate.rate)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
