"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  PricingRule,
  SessionSummary,
  TenantProduct,
  TenantSettings,
  UpdatePricingRule,
  UpdateTenantProduct,
  UpdateTenantSettings,
} from "@bullion/contracts";
import {
  ApiError,
  create_shop,
  fetch_pricing_rules,
  fetch_products,
  fetch_session,
  fetch_settings,
  update_pricing_rule,
  update_product,
  update_settings,
} from "@/lib/api";
import {
  acquire_token,
  active_account,
  AuthConfigError,
  get_msal,
  sign_in,
  sign_out,
} from "@/lib/auth";
import { PricingRuleEditor, type SaveResult } from "@/components/dashboard/PricingRuleEditor";
import { OnboardingForm, type CreateResult } from "@/components/dashboard/OnboardingForm";
import {
  ShopSettingsForm,
  type SettingsSaveResult,
} from "@/components/dashboard/ShopSettingsForm";
import { ProductSettings, type ProductSaveResult } from "@/components/dashboard/ProductSettings";
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
  /** Verified, but this identity owns no shop yet. */
  | { kind: "needs_shop" }
  /**
   * Sign-in is not configured in this build. Distinct from `error` because no
   * amount of retrying will help — the identity provider's details are baked
   * into the bundle at build time, so this is a deployment fact, not a fault.
   */
  | { kind: "auth_unconfigured"; message: string }
  | {
      kind: "ready";
      session: SessionSummary;
      rules: PricingRule[];
      settings: TenantSettings;
      products: TenantProduct[];
    }
  | { kind: "error"; message: string };

/** The dashboard's three jobs, kept apart so none of them is a long scroll. */
const TABS = [
  { id: "pricing", label: "Pricing" },
  { id: "products", label: "Products" },
  { id: "shop", label: "Shop details" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * The error shown when a write finds no usable token.
 *
 * A dashboard left open overnight outlives its token, so this is an ordinary
 * outcome rather than a fault. Built fresh per call so each failure carries its
 * own object, and defined at module scope so the save callbacks below do not
 * close over a value that changes every render.
 */
const session_expired = (): ApiError =>
  new ApiError(401, null, "Your session expired. Please sign in again.");

export default function Dashboard() {
  const [phase, set_phase] = useState<Phase>({ kind: "loading" });
  const [busy, set_busy] = useState(false);
  const [tab, set_tab] = useState<TabId>("pricing");

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

      // `fetch_session` is first and alone: it is the call that answers "does
      // this identity have a shop at all", and a 403 from it means onboarding
      // rather than an error. Issuing the rest alongside it would race four
      // 403s into the same handler.
      const session = await fetch_session(token);

      const [rules, settings, products] = await Promise.all([
        fetch_pricing_rules(token),
        fetch_settings(token),
        fetch_products(token),
      ]);

      set_phase({ kind: "ready", session, rules, settings, products });
    } catch (error) {
      // Checked before anything else: without a configured provider there is
      // no sign-in to offer, and "try again" would be a lie.
      if (error instanceof AuthConfigError) {
        set_phase({ kind: "auth_unconfigured", message: error.message });
        return;
      }

      if (error instanceof ApiError && error.is_unauthenticated) {
        // The token was rejected. Treat it as signed out rather than showing an
        // error the user cannot act on.
        set_phase({ kind: "signed_out" });
        return;
      }

      // Verified, but no tenant membership: a shopkeeper who has never set up a
      // shop. That is the normal first visit, not a failure, so it leads to
      // onboarding rather than an error the user cannot act on.
      if (error instanceof ApiError && error.status === 403) {
        set_phase({ kind: "needs_shop" });
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

  /**
   * Acquire a token for a write, or explain why not.
   *
   * Every save needs a fresh one — a dashboard left open outlives its token —
   * and the writers below would otherwise repeat the same six lines.
   */
  const token_for_write = useCallback(async (): Promise<string | null> => {
    const msal = await get_msal();
    return acquire_token(msal);
  }, []);

  const save = useCallback(
    async (
      rule_id: string,
      version: number,
      body: UpdatePricingRule,
    ): Promise<SaveResult> => {
      const token = await token_for_write();
      if (token === null) return { ok: false, error: session_expired() };

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
    [token_for_write],
  );

  const save_settings = useCallback(
    async (body: UpdateTenantSettings): Promise<SettingsSaveResult> => {
      const token = await token_for_write();
      if (token === null) return { ok: false, error: session_expired() };

      try {
        const settings = await update_settings(token, body);

        // The header reads the session's copy of the name, so it must advance
        // too — otherwise a renamed shop keeps its old heading until reload.
        set_phase((current) =>
          current.kind === "ready"
            ? {
                ...current,
                settings,
                session: {
                  ...current.session,
                  tenant: {
                    ...current.session.tenant,
                    display_name: settings.display_name,
                  },
                },
              }
            : current,
        );

        return { ok: true, settings };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, null, "Could not save your shop details."),
        };
      }
    },
    [token_for_write],
  );

  const save_product = useCallback(
    async (product_id: string, body: UpdateTenantProduct): Promise<ProductSaveResult> => {
      const token = await token_for_write();
      if (token === null) return { ok: false, error: session_expired() };

      try {
        const product = await update_product(token, product_id, body);

        set_phase((current) =>
          current.kind === "ready"
            ? {
                ...current,
                products: current.products.map((p) =>
                  p.product_id === product.product_id ? product : p,
                ),
              }
            : current,
        );

        return { ok: true, product };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, null, "Could not save that change."),
        };
      }
    },
    [token_for_write],
  );

  const create = useCallback(
    async (shop_name: string, slug: string | undefined): Promise<CreateResult> => {
      const token = await token_for_write();
      if (token === null) return { ok: false, error: session_expired() };

      try {
        const shop = await create_shop(token, {
          shop_name,
          ...(slug === undefined ? {} : { slug }),
        });
        // Re-read rather than construct the session locally: the server decides
        // the final slug, and a collision suffix means it may not be the one
        // this form previewed.
        await load();
        return { ok: true, shop };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, null, "Could not create your shop."),
        };
      }
    },
    [load, token_for_write],
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

  if (phase.kind === "needs_shop") {
    return (
      <main className={styles.centred} id="main">
        <OnboardingForm on_create={create} />
      </main>
    );
  }

  if (phase.kind === "auth_unconfigured") {
    return (
      <main className={styles.centred} id="main">
        <div className={styles.panel} role="alert">
          <h1 className={styles.panelTitle}>Sign-in isn&rsquo;t available here</h1>
          <p className={styles.panelBody}>
            This build has no identity provider configured, so there is no
            shopkeeper account to sign in to. Customer rate pages work normally.
          </p>
          {/* The specific missing setting, for whoever deployed this. */}
          <p className={styles.panelDetail}>{phase.message}</p>
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

  const { session, rules, settings, products } = phase;
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
              Share this with customers. It shows your rates, live.
            </p>
            <a className={styles.link} href={`/r/${session.tenant.public_slug}`}>
              /r/{session.tenant.public_slug}
            </a>
          </section>
        )}

        {/*
          A real tablist: arrow keys move between tabs and each panel is
          labelled by its tab, so this is navigable without a mouse.
        */}
        <div className={styles.tabs} role="tablist" aria-label="Dashboard sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => set_tab(t.id)}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (step === 0) return;
                event.preventDefault();
                const index = TABS.findIndex((candidate) => candidate.id === tab);
                const next = TABS[(index + step + TABS.length) % TABS.length];
                if (next !== undefined) {
                  set_tab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "pricing" ? (
          <section
            aria-labelledby="tab-pricing"
            className={styles.section}
            id="panel-pricing"
            role="tabpanel"
            tabIndex={0}
          >
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionHeading}>Pricing</h2>
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
              Customers are shown the market rate plus your adjustment. The
              market rate comes from the rate feed and the final figure is
              calculated by the server — this page never prices anything itself.
            </p>

            {active.length === 0 ? (
              <p className={styles.notice} role="status">
                No active pricing rules. Rates cannot be published until at
                least one product is configured.
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
        ) : null}

        {tab === "products" ? (
          <section
            aria-labelledby="tab-products"
            className={styles.section}
            id="panel-products"
            role="tabpanel"
            tabIndex={0}
          >
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionHeading}>Products</h2>
            </div>

            <p className={styles.explainer}>
              Choose what you quote and how it appears. Changes here take effect
              on your customer page immediately — there is nothing further to
              publish.
            </p>

            <ProductSettings products={products} on_save={save_product} />
          </section>
        ) : null}

        {tab === "shop" ? (
          <section
            aria-labelledby="tab-shop"
            className={styles.section}
            id="panel-shop"
            role="tabpanel"
            tabIndex={0}
          >
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionHeading}>Shop details</h2>
            </div>

            <p className={styles.explainer}>
              Your name, colour and contact details, as customers see them on
              your link.
            </p>

            <ShopSettingsForm settings={settings} on_save={save_settings} />
          </section>
        ) : null}
      </div>
    </main>
  );
}
