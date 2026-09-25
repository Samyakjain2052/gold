"use client";

import { useId, useState } from "react";
import type { TenantSettings, UpdateTenantSettings } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import styles from "./ShopSettingsForm.module.css";

/**
 * What the shop says about itself, and how customers reach it.
 *
 * ## Only what changed is sent
 *
 * The API treats an absent key and an explicit `null` as different intentions —
 * "leave this alone" and "clear this". A form that posted every field would
 * turn an untouched blank into a deliberate erasure, and would also make two
 * people editing different fields overwrite each other. So `diff()` compares
 * against the values this form loaded and sends nothing else.
 *
 * ## Visibility is a request, not an enforcement
 *
 * The `show_*` switches are sent to the API, which applies them when it builds
 * the public payload. A withheld number is absent from the response, not
 * hidden by CSS — so "hidden" means a customer cannot read it out of the page
 * source either.
 *
 * ## No concurrency token
 *
 * Unlike pricing, these writes carry no `If-Match`. Losing a race here costs a
 * retyped tagline; losing one on a margin costs money. The asymmetry is
 * deliberate.
 */

export type SettingsSaveResult =
  | { ok: true; settings: TenantSettings }
  | { ok: false; error: ApiError };

/** The form's own state: every field a string, as the DOM gives them. */
interface FormState {
  display_name: string;
  tagline: string;
  accent_color: string;
  phone: string;
  whatsapp: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  pincode: string;
  show_phone: boolean;
  show_whatsapp: boolean;
  show_address: boolean;
}

/** Nullable text fields, where a blank box means "clear this". */
const TEXT_FIELDS = [
  "tagline",
  "accent_color",
  "phone",
  "whatsapp",
  "email",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "pincode",
] as const;

const FLAGS = ["show_phone", "show_whatsapp", "show_address"] as const;

export function to_form(settings: TenantSettings): FormState {
  const { contact } = settings;
  return {
    display_name: settings.display_name,
    tagline: settings.tagline ?? "",
    accent_color: settings.accent_color ?? "",
    phone: contact.phone ?? "",
    whatsapp: contact.whatsapp ?? "",
    email: contact.email ?? "",
    address_line1: contact.address_line1 ?? "",
    address_line2: contact.address_line2 ?? "",
    city: contact.city ?? "",
    state: contact.state ?? "",
    pincode: contact.pincode ?? "",
    show_phone: contact.show_phone,
    show_whatsapp: contact.show_whatsapp,
    show_address: contact.show_address,
  };
}

/**
 * The changed fields only.
 *
 * A trimmed-to-empty text field becomes `null` — the user emptied the box, and
 * that is how you remove a phone number. A field equal to what was loaded is
 * left out entirely.
 */
export function diff(before: FormState, after: FormState): UpdateTenantSettings {
  const body: Record<string, string | boolean | null> = {};

  // `display_name` is the one field that cannot be cleared: a shop with no name
  // is not a shop, and the API's minimum length says so too.
  const name = after.display_name.trim();
  if (name !== before.display_name.trim() && name !== "") body["display_name"] = name;

  for (const field of TEXT_FIELDS) {
    const next = after[field].trim();
    if (next === before[field].trim()) continue;
    body[field] = next === "" ? null : next;
  }

  for (const flag of FLAGS) {
    if (after[flag] !== before[flag]) body[flag] = after[flag];
  }

  return body as UpdateTenantSettings;
}

export function ShopSettingsForm({
  settings,
  on_save,
}: {
  settings: TenantSettings;
  on_save: (body: UpdateTenantSettings) => Promise<SettingsSaveResult>;
}) {
  const id = useId();

  // What the server last confirmed, against which changes are measured. It
  // advances only on a successful save, so a failed one leaves the user's edits
  // in the boxes and still pending.
  const [saved_state, set_saved_state] = useState<FormState>(() => to_form(settings));
  const [form, set_form] = useState<FormState>(() => to_form(settings));

  const [saving, set_saving] = useState(false);
  const [error, set_error] = useState<ApiError | null>(null);
  const [confirmation, set_confirmation] = useState<string | null>(null);

  const field_errors = error?.field_errors ?? new Map<string, string>();
  const pending = diff(saved_state, form);
  const dirty = Object.keys(pending).length > 0;

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    set_form((current) => ({ ...current, [key]: value }));
    set_confirmation(null);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!dirty) return;

    set_saving(true);
    set_error(null);
    set_confirmation(null);

    const result = await on_save(pending);
    set_saving(false);

    if (!result.ok) {
      set_error(result.error);
      return;
    }

    // Re-seed from the server's answer rather than from what was typed: it is
    // the server that decides what was stored, and any normalisation it applied
    // must be what the next diff measures against.
    const confirmed = to_form(result.settings);
    set_saved_state(confirmed);
    set_form(confirmed);
    set_confirmation("Saved. Your customer page has been updated.");
  }

  const text = (
    key: (typeof TEXT_FIELDS)[number] | "display_name",
    label: string,
    extra: {
      hint?: string;
      type?: string;
      inputMode?: "text" | "tel" | "email" | "numeric";
      maxLength?: number;
      autoComplete?: string;
    } = {},
  ) => {
    const invalid = field_errors.has(key);
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-${key}`}>
          {label}
        </label>
        <input
          className={styles.input}
          id={`${id}-${key}`}
          name={key}
          type={extra.type ?? "text"}
          value={form[key]}
          onChange={(e) => set(key, e.target.value)}
          aria-invalid={invalid}
          {...(invalid ? { "aria-errormessage": `${id}-${key}-error` } : {})}
          {...(extra.inputMode === undefined ? {} : { inputMode: extra.inputMode })}
          {...(extra.maxLength === undefined ? {} : { maxLength: extra.maxLength })}
          {...(extra.autoComplete === undefined ? {} : { autoComplete: extra.autoComplete })}
        />
        {invalid ? (
          <p className={styles.fieldError} id={`${id}-${key}-error`}>
            {field_errors.get(key)}
          </p>
        ) : extra.hint !== undefined ? (
          <p className={styles.hint}>{extra.hint}</p>
        ) : null}
      </div>
    );
  };

  const toggle = (key: (typeof FLAGS)[number], label: string) => (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(e) => set(key, e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <form className={styles.card} onSubmit={(e) => void submit(e)} noValidate>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Shop identity</legend>

        {text("display_name", "Shop name", {
          hint: "Shown as the heading on your customer page.",
          maxLength: 120,
        })}
        {text("tagline", "Tagline", {
          hint: "Optional. For example, “Since 1985, Zaveri Bazaar”.",
          maxLength: 160,
        })}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-accent_color`}>
            Accent colour
          </label>
          <div className={styles.colourRow}>
            {/*
              Two controls, one value. The picker is convenient but cannot be
              cleared or read aloud; the text box can, and accepts a hex code
              pasted from a brand guide.
            */}
            <input
              className={styles.swatch}
              id={`${id}-accent_color`}
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(form.accent_color) ? form.accent_color : "#8a6516"}
              onChange={(e) => set("accent_color", e.target.value)}
              aria-label="Pick accent colour"
            />
            <input
              className={styles.input}
              name="accent_color"
              value={form.accent_color}
              onChange={(e) => set("accent_color", e.target.value)}
              placeholder="#8a6516"
              aria-label="Accent colour hex code"
              aria-invalid={field_errors.has("accent_color")}
              {...(field_errors.has("accent_color")
                ? { "aria-errormessage": `${id}-accent-error` }
                : {})}
            />
          </div>
          {field_errors.has("accent_color") ? (
            <p className={styles.fieldError} id={`${id}-accent-error`}>
              {field_errors.get("accent_color")}
            </p>
          ) : (
            <p className={styles.hint}>
              A hex code such as #8a6516. Leave blank to use the default.
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>How customers reach you</legend>
        <p className={styles.help}>
          Each of these appears on your customer page only if you tick it. What
          you untick is withheld by the server, not just hidden.
        </p>

        <div className={styles.grid}>
          <div className={styles.contactPair}>
            {text("phone", "Phone", {
              inputMode: "tel",
              autoComplete: "tel",
              hint: "With country code, for example +91 98200 00000.",
            })}
            {toggle("show_phone", "Show on customer page")}
          </div>

          <div className={styles.contactPair}>
            {text("whatsapp", "WhatsApp", { inputMode: "tel" })}
            {toggle("show_whatsapp", "Show on customer page")}
          </div>
        </div>

        {text("email", "Email", { type: "email", inputMode: "email" })}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Address</legend>
        {toggle("show_address", "Show my address on the customer page")}

        {text("address_line1", "Address line 1", { maxLength: 160 })}
        {text("address_line2", "Address line 2", { maxLength: 160 })}

        <div className={styles.grid}>
          {text("city", "City", { maxLength: 80 })}
          {text("state", "State", { maxLength: 80 })}
          {text("pincode", "PIN code", { inputMode: "numeric", maxLength: 6 })}
        </div>
      </fieldset>

      <div aria-live="polite" className={styles.status}>
        {error !== null ? (
          <p className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}
        {confirmation !== null ? <p className={styles.saved}>{confirmation}</p> : null}
      </div>

      <div className={styles.actions}>
        {dirty ? <span className={styles.unsaved}>Unsaved changes</span> : null}
        <button className={styles.primary} type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save shop details"}
        </button>
      </div>
    </form>
  );
}
