import styles from "./SimulatedBanner.module.css";

/**
 * Says, unmissably, that the rates on screen are not real.
 *
 * The API reports `meta.simulated` when it is running the mock provider. That
 * provider is refused in production by config validation, so this banner can
 * only ever appear outside production — but "can only" is not "does not", and
 * simulated bullion rates that look live are the one thing on this page that
 * could cause someone real financial loss.
 *
 * It is therefore deliberately not dismissible, not subtle, and placed above
 * the rates rather than below them. `role="alert"` makes a screen reader
 * announce it on arrival rather than only when reached.
 */
export function SimulatedBanner({ simulated }: { simulated: boolean }) {
  if (!simulated) return null;

  return (
    <aside className={styles.banner} role="alert">
      <span className={styles.tag}>Development</span>
      <span className={styles.text}>
        <strong>These are simulated rates.</strong> They are generated for
        testing and bear no relation to real gold or silver prices. Do not trade
        on them.
      </span>
    </aside>
  );
}
