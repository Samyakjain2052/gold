"use client";

import { useState } from "react";
import type { OnboardingResult } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import styles from "./OnboardingForm.module.css";

/**
 * What a shopkeeper sees the first time they sign in.
 *
 * Before this existed, a new account reached the dashboard, got a `403` from
 * every endpoint, and had no way forward — the only shops that existed were
 * seeded by hand. This is the step that turns a verified identity into a shop.
 *
 * ## One field, not a wizard
 *
 * A shop needs a name. Everything else — products, rounding, the customer link
 * — the server can choose sensibly and the shopkeeper can change afterwards.
 * Asking for margins here would be asking a business question before the
 * shopkeeper has seen a single rate.
 *
 * The link is offered as an optional override rather than a required decision,
 * with a live preview of what the name will produce, because the URL is the
 * thing they will print and share.
 */
export type CreateResult =
  | { ok: true; shop: OnboardingResult }
  | { ok: false; error: ApiError };

export function OnboardingForm({
  on_create,
}: {
  on_create: (shop_name: string, slug: string | undefined) => Promise<CreateResult>;
}) {
  const [shop_name, set_shop_name] = useState("");
  const [slug, set_slug] = useState("");
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState<ApiError | null>(null);

  const preview = slug.trim() !== "" ? slugify(slug) : slugify(shop_name);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    set_busy(true);
    set_error(null);

    const result = await on_create(
      shop_name.trim(),
      slug.trim() === "" ? undefined : slug.trim(),
    );

    set_busy(false);
    if (!result.ok) set_error(result.error);
  }

  return (
    <form className={styles.panel} onSubmit={(e) => void submit(e)} noValidate>
      <h1 className={styles.title}>Set up your shop</h1>
      <p className={styles.intro}>
        This creates your rate page and the link you share with customers. You
        can change your rates straight afterwards.
      </p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="shop-name">
          Shop name
        </label>
        <input
          className={styles.input}
          id="shop-name"
          name="shop_name"
          value={shop_name}
          onChange={(e) => set_shop_name(e.target.value)}
          placeholder="Radhika Jewellers"
          autoComplete="organization"
          required
          aria-describedby="shop-name-hint"
        />
        <p className={styles.hint} id="shop-name-hint">
          Shown at the top of your rate page.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="shop-slug">
          Your link <span className={styles.optional}>(optional)</span>
        </label>
        <div className={styles.linkRow}>
          <span className={styles.prefix} aria-hidden="true">
            /r/
          </span>
          <input
            className={styles.input}
            id="shop-slug"
            name="slug"
            value={slug}
            onChange={(e) => set_slug(e.target.value)}
            placeholder={slugify(shop_name) || "radhika-jewellers"}
            aria-describedby="shop-slug-hint"
          />
        </div>
        <p className={styles.hint} id="shop-slug-hint">
          {preview === ""
            ? "Leave blank and we'll create one from your shop name."
            : `Customers will open /r/${preview}`}
        </p>
      </div>

      {/* Announced, not merely coloured. */}
      <div aria-live="polite">
        {error === null ? null : (
          <p className={styles.error} role="alert">
            {error.is_conflict
              ? "This account already has a shop. Reload the page to open it."
              : error.message}
          </p>
        )}
      </div>

      <button className={styles.primary} type="submit" disabled={busy || shop_name.trim() === ""}>
        {busy ? "Creating…" : "Create my shop"}
      </button>
    </form>
  );
}

/**
 * Preview the link the server will derive.
 *
 * A local copy of the server's rule, used only to show what will happen. The
 * server decides the real slug — including collision suffixes, which this
 * cannot know about — so this is a hint, never a promise.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49)
    .replace(/-+$/g, "");
}
