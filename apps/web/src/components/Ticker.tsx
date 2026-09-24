import styles from "./Ticker.module.css";

/**
 * The scrolling notice strip above the board.
 *
 * Every jeweller's board carries standing text — that rates are indicative,
 * that they move, that the counter price is the one that counts. It belongs
 * where the eye lands before the numbers.
 *
 * ## Moving text is an accessibility hazard, so it is handled carefully
 *
 * WCAG 2.2.2 requires that motion lasting more than five seconds can be paused.
 * This one:
 *
 * - stops on hover and on keyboard focus, so a reader can catch up;
 * - does not move at all under `prefers-reduced-motion`, where the full text is
 *   simply wrapped and shown statically;
 * - is duplicated for the seamless loop, with the copy hidden from assistive
 *   technology so the sentence is not announced twice.
 *
 * The text is not tenant-controlled today. When it becomes so it must be
 * treated as untrusted input, exactly as `accent_color` is.
 */
export function Ticker({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;

  const line = messages.join("   ·   ");

  return (
    <div className={styles.ticker} role="region" aria-label="Shop notices">
      <div className={styles.track} tabIndex={0}>
        <span className={styles.text}>{line}</span>
        {/* The seamless second copy. Hidden from screen readers so the notice
            is read once, not twice. */}
        <span className={styles.text} aria-hidden="true">
          {line}
        </span>
      </div>
    </div>
  );
}

/**
 * The standing notices for a shop page.
 *
 * Deliberately not a marketing slot: these are the statements a customer needs
 * in order to read the numbers correctly.
 */
export function default_notices(shop_name: string): string[] {
  return [
    "Rates are indicative and move with the market",
    `Confirm the final price with ${shop_name} before purchase`,
    "Making charges, wastage and GST are additional where applicable",
  ];
}
