"use client";

import { useCallback, useEffect, useState } from "react";
import type { PricingRule, SessionSummary, UpdatePricingRule } from "@bullion/contracts";
import {
  ApiError,
  fetch_pricing_rules,
  fetch_session,
  update_pricing_rule,
} from "@/lib/api";
import { acquire_token, active_account, get_msal, sign_in, sign_out } from "@/lib/auth";
import { PricingRuleEditor, type SaveResult } from "@/components/dashboard/PricingRuleEditor";
import styles from "./page.module.css";

/**
 * The shopkeeper dashboard.
 *
 * Client-rendered: it is behind interactive sign-in, personal to one user, and
 * must never be cached or prerendered.
 *
 * ## Authorisation is not decided here
 *
 * This component decides only what to *show*. Every question of what the user
 * may actually do is answered by the API against the verified token: the
 * tenant comes from `oid`+`tid`, and the role from the membership row. Nothing
 * here sends a tenant id, and hiding a control is treated as a courtesy, not a
 * control — the server refuses the request regardless.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "ready"; session: SessionSummary; rules: PricingRule[] }
  | { kind: "error"; message: string };

export default function Dashboard() {
  const [phase, set_phase] = useState<Phase>({ kind: "loading" });
  const [busy, set_busy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const msal = await get_msal();
      // Completes a redirect that landed straight here rather than on
      // /auth/callback, which happens when the provider returns to the
      // originating URL.
      await msal.handleRedirectPromise();

      if (active_account(msal) === null) {
        set_phase({ kind: "signed_out" });
        return;
      }

      const token = await acquire_token(msal);
      if (token === null) {
        set_phase({ kind: "signed_out" });
        return;
      }

      const [session, rules] = await Promise.all([
        fetch_session(token),
        fetch_pricing_rules(token),
      ]);

      set_phase({ kind: "ready", session, rules });
    } catch (error) {
      if (error instanceof ApiError && error.is_unauthenticated) {
        // The token was rejected. Treat it as signed out rather than showing an
        // error the user cannot act on.
        set_phase({ kind: "signed_out" });
        return;
      }
      set_phase({
        kind: "error",
        message:
          error instanceof ApiError
            ? error.message
            : "Something went wrong loading your dashboard.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (
      rule_id: string,
      version: number,
      body: UpdatePricingRule,
    ): Promise<SaveResult> => {
      const msal = await get_msal();
      const token = await acquire_token(msal);

      if (token === null) {
        return {
          ok: false,
          error: new ApiError(401, null, "Your session expired. Please sign in again."),
        };
      }

      try {
        const rule = await update_pricing_rule(token, rule_id, version, body);

        // Replace the saved rule in place so its new version is quoted on the
        // next save; leaving the old one would make every later save conflict.
        set_phase((current) =>
          current.kind === "ready"
            ? {
                ...current,
                rules: current.rules.map((r) => (r.id === rule.id ? rule : r)),
              }
            : current,
        );

        return { ok: true, rule };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, null, "Could not save your change."),
        };
      }
    },
    [],
  );

  const reload = useCallback(() => {
    set_busy(true);
    void load().finally(() => set_busy(false));
  }, [load]);

  if (phase.kind === "loading") {
    return (
      <main className={styles.centred} id="main">
        <p role="status">Loading your dashboard…</p>
      </main>
    );
  }

  if (phase.kind === "signed_out") {
    return (
      <main className={styles.centred} id="main">
        <div className={styles.panel}>
          <h1 className={styles.panelTitle}>Shopkeeper sign in</h1>
          <p className={styles.panelBody}>
            Sign in to manage the rates your customers see.
          </p>
          <button
            className={styles.primary}
            type="button"
            onClick={() => void get_msal().then(sign_in)}
          >
            Sign in
          </button>
        </div>
      </main>
    );
  }

  if (phase.kind === "error") {
    return (
      <main className={styles.centred} id="main">
        <div className={styles.panel} role="alert">
          <h1 className={styles.panelTitle}>We couldn&rsquo;t load your dashboard</h1>
          <p className={styles.panelBody}>{phase.message}</p>
          <button className={styles.primary} type="button" onClick={reload}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const { session, rules } = phase;
  const active = rules.filter((r) => r.is_active);

  return (
    <main className={styles.page} id="main">
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.shopName}>{session.tenant.display_name}</h1>
            <p className={styles.role}>
              Signed in as {session.user.role}
              {session.tenant.status !== "active" ? (
                <> · account {session.tenant.status}</>
              ) : null}
            </p>
          </div>

          <button
            className={styles.secondary}
            type="button"
            onClick={() => void get_msal().then(sign_out)}
          >
            Sign out
          </button>
        </header>

        {session.tenant.public_slug === null ? (
          <p className={styles.notice} role="status">
            No customer link has been issued for this shop yet, so there is
            nothing for customers to open.
          </p>
        ) : (
          <section className={styles.linkPanel} aria-labelledby="link-heading">
            <h2 className={styles.sectionHeading} id="link-heading">
              Your customer link
            </h2>
            <p className={styles.linkBody}>
              Share this with customers. It shows the rates below, live.
            </p>
            <a className={styles.link} href={`/r/${session.tenant.public_slug}`}>
              /r/{session.tenant.public_slug}
            </a>
          </section>
        )}

        <section aria-labelledby="pricing-heading" className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionHeading} id="pricing-heading">
              Pricing
            </h2>
            <button
              className={styles.secondary}
              type="button"
              onClick={reload}
              disabled={busy}
            >
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <p className={styles.explainer}>
            Customers are shown the market rate plus your adjustment. The market
            rate comes from the rate feed and the final figure is calculated by
            the server — this page never prices anything itself.
          </p>

          {active.length === 0 ? (
            <p className={styles.notice} role="status">
              No active pricing rules. Rates cannot be published until at least
              one product is configured.
            </p>
          ) : (
            <div className={styles.rules}>
              {active.map((rule) => (
                <PricingRuleEditor
                  key={rule.id}
                  rule={rule}
                  on_save={save}
                  on_reload={reload}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
