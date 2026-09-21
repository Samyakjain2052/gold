import Link from "next/link";
import styles from "./page.module.css";

/**
 * The bare root.
 *
 * Customers arrive at `/r/{slug}`, never here, so this exists only to give a
 * shopkeeper a way into the dashboard. It deliberately does not list shops:
 * enumerating tenants is precisely what the slug design avoids.
 */
export default function Home() {
  return (
    <main className={styles.page} id="main">
      <div className={styles.panel}>
        <h1 className={styles.title}>Live bullion rates</h1>
        <p className={styles.body}>
          Publish your shop&rsquo;s gold and silver rates to a link you can share
          with customers.
        </p>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/dashboard">
            Shopkeeper sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
