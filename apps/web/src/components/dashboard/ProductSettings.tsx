"use client";

import { useId, useState } from "react";
import type { DisplayUnit, TenantProduct, UpdateTenantProduct } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import styles from "./ProductSettings.module.css";

/**
 * Which products this shop quotes, and how each one is shown.
 *
 * ## Each control saves on change
 *
 * These are single, independent decisions — a switch, a unit — not a form to be
 * filled in and submitted. Batching them behind a Save button would invite the
 * shopkeeper to flip three switches and walk away believing all three took.
 * Each change is sent immediately and reported individually.
 *
 * ## A unit change is not cosmetic
 *
 * The published rate is an amount *in* its display unit, so changing the unit
 * makes the stored figure wrong until the server recomputes it. The server does
 * that inside the same transaction. This component does not rescale anything
 * itself — ₹14,081 per 10g is not "₹1,408.1 per gram" arrived at by dividing in
 * the browser, because that would be the browser pricing.
 */

const UNITS: readonly { value: DisplayUnit; label: string }[] = [
  { value: "per_gram", label: "Per gram" },
  { value: "per_10_gram", label: "Per 10 grams" },
  { value: "per_kilogram", label: "Per kilogram" },
];

export type ProductSaveResult =
  | { ok: true; product: TenantProduct }
  | { ok: false; error: ApiError };

export function ProductSettings({
  products,
  on_save,
}: {
  products: readonly TenantProduct[];
  on_save: (product_id: string, body: UpdateTenantProduct) => Promise<ProductSaveResult>;
}) {
  if (products.length === 0) {
    return (
      <p className={styles.empty} role="status">
        No products are available to configure.
      </p>
    );
  }

  return (
    <ul className={styles.list}>
      {products.map((product) => (
        <ProductRow key={product.product_id} product={product} on_save={on_save} />
      ))}
    </ul>
  );
}

function ProductRow({
  product,
  on_save,
}: {
  product: TenantProduct;
  on_save: (product_id: string, body: UpdateTenantProduct) => Promise<ProductSaveResult>;
}) {
  const id = useId();
  const [current, set_current] = useState(product);
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState<ApiError | null>(null);
  const [note, set_note] = useState<string | null>(null);

  async function apply(body: UpdateTenantProduct, message: string): Promise<void> {
    set_busy(true);
    set_error(null);
    set_note(null);

    const result = await on_save(current.product_id, body);
    set_busy(false);

    if (!result.ok) {
      set_error(result.error);
      return;
    }

    // The server's answer, not the requested value: it is the authority on what
    // was stored.
    set_current(result.product);
    set_note(message);
  }

  const unpriced = current.is_enabled && !current.has_pricing_rule;

  return (
    <li className={`${styles.row} ${current.is_enabled ? "" : styles.disabled}`}>
      <div className={styles.head}>
        <div>
          <h3 className={styles.title}>{current.label}</h3>
          <p className={styles.meta}>
            {current.metal} · {current.purity.num}/{current.purity.den}
          </p>
        </div>

        <label className={styles.enable}>
          <input
            type="checkbox"
            checked={current.is_enabled}
            disabled={busy}
            onChange={(e) =>
              void apply(
                { is_enabled: e.target.checked },
                e.target.checked
                  ? "Now shown to customers."
                  : "Removed from your customer page.",
              )
            }
          />
          <span>{current.is_enabled ? "Quoting" : "Not quoting"}</span>
        </label>
      </div>

      {current.is_enabled ? (
        <div className={styles.controls}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-unit`}>
              Quote
            </label>
            <select
              className={styles.select}
              id={`${id}-unit`}
              value={current.display_unit}
              disabled={busy}
              onChange={(e) =>
                void apply(
                  { display_unit: e.target.value as DisplayUnit },
                  "Unit changed. The rate has been recalculated for the new unit.",
                )
              }
            >
              {UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </select>
          </div>

          <label className={styles.breakdown}>
            <input
              type="checkbox"
              checked={current.show_base_rate}
              disabled={busy}
              onChange={(e) =>
                void apply(
                  { show_base_rate: e.target.checked },
                  e.target.checked
                    ? "Customers can now see the market rate and your margin."
                    : "The breakdown is hidden from customers.",
                )
              }
            />
            <span>
              Show the market rate and my margin
              <small className={styles.breakdownHint}>
                Customers see what the metal costs and what you add. Off by
                default.
              </small>
            </span>
          </label>
        </div>
      ) : null}

      <div aria-live="polite" className={styles.status}>
        {unpriced ? (
          <p className={styles.warning}>
            No pricing set, so no rate is published for this product yet. Set an
            adjustment under Pricing.
          </p>
        ) : null}
        {error !== null ? (
          <p className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}
        {note !== null && error === null ? <p className={styles.note}>{note}</p> : null}
      </div>
    </li>
  );
}
