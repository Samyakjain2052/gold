import styles from "./not-found.module.css";

/**
 * Shown for an unknown shop link.
 *
 * Says nothing about whether the slug ever existed. The API already returns the
 * same `404` for a malformed slug and an unknown one, and this page keeps that
 * property: a page that distinguished them would let someone enumerate shops.
 */
export default function NotFound() {
  return (
    <main className={styles.page} id="main">
      <div className={styles.panel}>
        <h1 className={styles.title}>Shop not found</h1>
        <p className={styles.body}>
          We could not find a shop at this link. Please check it with the shop,
          or ask them to send it again.
        </p>
      </div>
    </main>
  );
}
