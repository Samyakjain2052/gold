"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { get_msal } from "@/lib/auth";
import styles from "./page.module.css";

/**
 * Where Entra returns after sign-in.
 *
 * MSAL parses the response out of the URL fragment, stores the tokens in
 * session storage, and this component then sends the user on. The fragment is
 * never read, logged or persisted by our own code.
 *
 * A failure here is shown as a plain message with a way back, rather than a
 * redirect loop — an account that cannot complete sign-in would otherwise
 * bounce between this page and the provider indefinitely.
 */
export default function AuthCallback() {
  const router = useRouter();
  const [failed, set_failed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const msal = await get_msal();
        const result = await msal.handleRedirectPromise();

        if (result?.account != null) {
          msal.setActiveAccount(result.account);
        }

        if (!cancelled) router.replace("/dashboard");
      } catch {
        // Deliberately no detail: an auth error can carry identifiers, and
        // this string is rendered into the page.
        if (!cancelled) set_failed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className={styles.page} id="main">
      {failed ? (
        <div className={styles.panel} role="alert">
          <h1 className={styles.title}>Sign-in could not be completed</h1>
          <p className={styles.body}>
            Something went wrong while signing you in. Please try again.
          </p>
          <a className={styles.link} href="/dashboard">
            Back to sign in
          </a>
        </div>
      ) : (
        <p className={styles.status} role="status">
          Signing you in…
        </p>
      )}
    </main>
  );
}
