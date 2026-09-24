import type { PublicShop } from "@bullion/contracts";
import styles from "./ShopActions.module.css";

/**
 * The sticky action bar at the foot of a shop page.
 *
 * A customer reading rates on a phone wants one thing next: to reach the shop.
 * Keeping call and WhatsApp within thumb reach saves them scrolling back to the
 * header.
 *
 * ## Why this is not a tab bar
 *
 * The reference boards jewellers use carry tabs for coin rates, updates and
 * bank details. Those are real sections, and this product does not have them
 * yet. Rendering them as tabs that lead nowhere would be worse than leaving
 * them out: a customer who taps "Bank Details" and gets nothing learns the page
 * is broken, not that the feature is coming.
 *
 * So this bar carries only what the shop has actually published. A shop with no
 * published contact details gets no bar at all.
 */
export function ShopActions({ shop }: { shop: PublicShop }) {
  const actions = [
    shop.contact.phone === null
      ? null
      : { key: "call", label: "Call", href: `tel:${shop.contact.phone}`, glyph: "☎" },
    shop.contact.whatsapp === null
      ? null
      : {
          key: "whatsapp",
          label: "WhatsApp",
          href: `https://wa.me/${shop.contact.whatsapp.replace(/[^\d]/g, "")}`,
          glyph: "✆",
        },
    shop.contact.email === null
      ? null
      : { key: "email", label: "Email", href: `mailto:${shop.contact.email}`, glyph: "✉" },
  ].filter((a): a is { key: string; label: string; href: string; glyph: string } => a !== null);

  if (actions.length === 0) return null;

  return (
    <nav className={styles.bar} aria-label="Contact this shop">
      <ul className={styles.list}>
        {actions.map((action) => (
          <li key={action.key} className={styles.item}>
            <a className={styles.action} href={action.href}>
              <span className={styles.glyph} aria-hidden="true">
                {action.glyph}
              </span>
              <span className={styles.label}>{action.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
