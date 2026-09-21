"use client";

import { useId, useState } from "react";
import type { PricingRule, RoundingMode, UpdatePricingRule } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import styles from "./PricingRuleEditor.module.css";

/**
 * Edit one product's pricing rule.
 *
 * ## What this form does not do
 *
 * It does not price anything. It sends the shopkeeper's intent to the API and
 * renders what comes back. There is no preview computed in the browser: a
 * locally-calculated "your customers will see ₹X" would be a second pricing
 * implementation, and the first time it disagreed with the server it would be
 * the shopkeeper who found out, through a customer.
 *
 * The resulting customer rate is shown on the public preview, which reads the
 * same published rates a customer does.
 *
 * ## Concurrency
 *
 * `version` is quoted back on save. Two devices editing the same shop is
 * ordinary — a manager on the counter tablet and the owner on a phone — so the
 * losing save is reported as a real, explicable event with a reload action,
 * never silently retried over the other person's change.
 */

const ROUNDING_STEPS: readonly { value: number; label: string }[] = [
  { value: 1, label: "1 paisa" },
  { value: 10, label: "10 paise" },
  { value: 100, label: "₹1" },
  { value: 500, label: "₹5" },
  { value: 1000, label: "₹10" },
  { value: 10000, label: "₹100" },
];

const ROUNDING_MODES: readonly { value: RoundingMode; label: string }[] = [
  { value: "half_up", label: "Nearest (half up)" },
  { value: "half_even", label: "Nearest (banker's)" },
  { value: "up", label: "Always up" },
  { value: "down", label: "Always down" },
];

export type SaveResult = { ok: true; rule: PricingRule } | { ok: false; error: ApiError };

export function PricingRuleEditor({
  rule,
  on_save,
  on_reload,
}: {
  rule: PricingRule;
  on_save: (rule_id: string, version: number, body: UpdatePricingRule) => Promise<SaveResult>;
  on_reload: () => void;
}) {
  const field_id = useId();

  const [kind, set_kind] = useState(rule.adjustment_kind);
  const [amount, set_amount] = useState(rule.adjustment_rupees_per_gram ?? "0");
  const [bps, set_bps] = useState(String(rule.adjustment_bps ?? 0));
  const [step, set_step] = useState(rule.rounding_step_paise);
  const [mode, set_mode] = useState<RoundingMode>(rule.rounding_mode);

  const [saving, set_saving] = useState(false);
  const [error, set_error] = useState<ApiError | null>(null);
  const [saved, set_saved] = useState(false);

  const field_errors = error?.field_errors ?? new Map<string, string>();
  const conflict = error?.is_conflict === true;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    set_saving(true);
    set_error(null);
    set_saved(false);

    const body: UpdatePricingRule =
      kind === "absolute"
        ? {
            adjustment_kind: "absolute",
            adjustment_rupees_per_gram: amount.trim(),
            rounding_step_paise: step,
            rounding_mode: mode,
            component_precision_paise: rule.component_precision_paise,
          }
        : {
            adjustment_kind: "percentage",
            // Sent as an integer: basis points never touch a float, on either
            // side of the wire.
            adjustment_bps: Number.parseInt(bps, 10),
            rounding_step_paise: step,
            rounding_mode: mode,
            component_precision_paise: rule.component_precision_paise,
          };

    const result = await on_save(rule.id, rule.version, body);
    set_saving(false);

    if (result.ok) {
      set_saved(true);
      return;
    }
    set_error(result.error);
  }

  return (
    <form className={styles.card} onSubmit={(e) => void submit(e)} noValidate>
      <header className={styles.header}>
        <h3 className={styles.title}>{rule.product_label}</h3>
        <span className={styles.version}>
          {rule.metal} {rule.purity.num}/{rule.purity.den} · v{rule.version}
        </span>
      </header>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Your adjustment</legend>
        <p className={styles.help} id={`${field_id}-help`}>
          Added to the market rate to produce the rate your customers see. The
          final rate is calculated by the server.
        </p>

        <div className={styles.kindRow} role="radiogroup" aria-label="Adjustment type">
          {(["absolute", "percentage"] as const).map((option) => (
            <label key={option} className={styles.kindOption}>
              <input
                type="radio"
                name={`${field_id}-kind`}
                value={option}
                checked={kind === option}
                onChange={() => set_kind(option)}
              />
              <span>{option === "absolute" ? "Fixed amount" : "Percentage"}</span>
            </label>
          ))}
        </div>

        {kind === "absolute" ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${field_id}-amount`}>
              Rupees per gram
            </label>
            <input
              className={styles.input}
              id={`${field_id}-amount`}
              name="adjustment_rupees_per_gram"
              inputMode="decimal"
              value={amount}
              onChange={(e) => set_amount(e.target.value)}
              aria-describedby={`${field_id}-help`}
              aria-invalid={field_errors.has("adjustment_rupees_per_gram")}
              {...(field_errors.has("adjustment_rupees_per_gram")
                ? { "aria-errormessage": `${field_id}-amount-error` }
                : {})}
            />
            {field_errors.has("adjustment_rupees_per_gram") ? (
              <p className={styles.fieldError} id={`${field_id}-amount-error`}>
                {field_errors.get("adjustment_rupees_per_gram")}
              </p>
            ) : (
              <p className={styles.hint}>
                Negative values are a discount, for example −25.00
              </p>
            )}
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${field_id}-bps`}>
              Basis points
            </label>
            <input
              className={styles.input}
              id={`${field_id}-bps`}
              name="adjustment_bps"
              inputMode="numeric"
              value={bps}
              onChange={(e) => set_bps(e.target.value)}
              aria-invalid={field_errors.has("adjustment_bps")}
              {...(field_errors.has("adjustment_bps")
                ? { "aria-errormessage": `${field_id}-bps-error` }
                : {})}
            />
            {field_errors.has("adjustment_bps") ? (
              <p className={styles.fieldError} id={`${field_id}-bps-error`}>
                {field_errors.get("adjustment_bps")}
              </p>
            ) : (
              <p className={styles.hint}>100 basis points = 1%</p>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Display rounding</legend>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${field_id}-step`}>
              Round to
            </label>
            <select
              className={styles.input}
              id={`${field_id}-step`}
              value={step}
              onChange={(e) => set_step(Number(e.target.value))}
            >
              {ROUNDING_STEPS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${field_id}-mode`}>
              Rounding rule
            </label>
            <select
              className={styles.input}
              id={`${field_id}-mode`}
              value={mode}
              onChange={(e) => set_mode(e.target.value as RoundingMode)}
            >
              {ROUNDING_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {/* Errors and confirmations are announced, not merely coloured. */}
      <div aria-live="polite" className={styles.status}>
        {conflict ? (
          <div className={styles.conflict} role="alert">
            <p className={styles.conflictTitle}>
              Someone else changed this rate while you were editing
            </p>
            <p className={styles.conflictBody}>
              Your change was not saved, so theirs is intact. Reload to see the
              current values, then reapply your change if you still want it.
            </p>
            <button type="button" className={styles.secondary} onClick={on_reload}>
              Reload current values
            </button>
          </div>
        ) : null}

        {error !== null && !conflict ? (
          <p className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}

        {saved ? <p className={styles.saved}>Saved.</p> : null}
      </div>

      <div className={styles.actions}>
        <button className={styles.primary} type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
