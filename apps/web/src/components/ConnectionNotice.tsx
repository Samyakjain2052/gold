import type { ConnectionState } from "@/lib/useRateStream";
import styles from "./ConnectionNotice.module.css";

/**
 * The state of the live connection, in words.
 *
 * Only shown when there is something the customer should know. A healthy
 * connection says nothing: a persistent "connected" badge is noise, and noise
 * is what makes people stop reading the banner that matters.
 *
 * "Reconnecting" explicitly reassures that the prices on screen are the last
 * known good ones, because the alternative reading — that they are wrong — is
 * the one a customer will otherwise assume.
 */
const NOTICE: Partial<Record<ConnectionState, { title: string; body: string }>> = {
  reconnecting: {
    title: "Reconnecting",
    body: "Showing the last rates received. Live updates will resume automatically.",
  },
  unavailable: {
    title: "Live updates unavailable",
    body: "These rates were correct when the page loaded. Refresh to check for changes.",
  },
};

export function ConnectionNotice({ state }: { state: ConnectionState }) {
  const notice = NOTICE[state];
  if (notice === undefined) return null;

  return (
    <div className={`${styles.notice} ${styles[state]}`} role="status">
      <span className={styles.title}>{notice.title}</span>
      <span className={styles.body}>{notice.body}</span>
    </div>
  );
}
