import styles from "./LinkReplaced.module.css";

/**
 * Shown for a slug the shopkeeper has rotated (API `410 Gone`).
 *
 * Distinct from "not found" on purpose. A rotated link means the shop exists
 * and the customer's link is simply old — telling them "not found" would send
 * them looking for a shop they can still perfectly well visit. Rotation is also
 * how a shopkeeper revokes a link that spread too widely, so the new address is
 * deliberately *not* offered here: whoever is meant to have it will be sent it.
 */
export function LinkReplaced() {
  return (
    <div className={styles.panel} role="status">
      <h1 className={styles.title}>This link has been replaced</h1>
      <p className={styles.body}>
        The shop has issued a new rate link, so this one no longer works. Please
        ask them for their current link.
      </p>
    </div>
  );
}
