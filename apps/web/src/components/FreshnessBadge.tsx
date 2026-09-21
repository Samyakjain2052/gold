import type { Freshness } from "@bullion/contracts";
import styles from "./FreshnessBadge.module.css";

/**
 * How current a rate is.
 *
 * Freshness is never communicated by colour alone: each state carries its own
 * word and its own glyph, so the distinction survives a monochrome screen, a
 * colour-blind reader and a screen reader. The colour is reinforcement.
 *
 * `expired` is deliberately not styled as a mild warning. A rate old enough to
 * expire must not be read as a price, and the UI says so in words.
 */
const PRESENTATION: Record<
  Freshness,
  { label: string; glyph: string; description: string }
> = {
  fresh: {
    label: "Live",
    glyph: "●",
    description: "Updating live",
  },
  stale: {
    label: "Delayed",
    glyph: "◐",
    description: "This rate has not updated recently",
  },
  expired: {
    label: "Out of date",
    glyph: "○",
    description: "Too old to rely on — please confirm with the shop",
  },
};

export function FreshnessBadge({
  freshness,
  className,
}: {
  freshness: Freshness;
  className?: string;
}) {
  const presentation = PRESENTATION[freshness];

  return (
    <span
      className={`${styles.badge} ${styles[freshness]} ${className ?? ""}`}
      data-freshness={freshness}
    >
      <span className={styles.glyph} aria-hidden="true">
        {presentation.glyph}
      </span>
      <span className={styles.label}>{presentation.label}</span>
      {/* The badge text alone is terse; the full sentence goes to assistive
          technology so the state is not just a one-word label out of context. */}
      <span className="visually-hidden">. {presentation.description}.</span>
    </span>
  );
}

export function freshness_description(freshness: Freshness): string {
  return PRESENTATION[freshness].description;
}
