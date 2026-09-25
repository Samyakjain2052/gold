/**
 * The pure half of shop settings: shapes, validation, and field mapping.
 *
 * Split from `tenant_settings_service.ts` the same way `pricing_rule_dto.ts` is
 * split from `pricing_rule_service.ts`. What is here needs no database and is
 * fully determined by its inputs, so it is unit-tested directly; what is there
 * is a transaction under RLS and is only meaningful against a real one.
 *
 * The split is not cosmetic. Three of the decisions in this file — what may be
 * set, what is written to the audit log, and what a colour is allowed to be —
 * are exactly the decisions worth pinning down with cheap, exhaustive tests.
 */
import { z } from "zod";

/**
 * A plain hex colour.
 *
 * `accent_color` is rendered into a style attribute on a public page, so this
 * is constrained on the way **in** as well as on the way out. The frontend's
 * `safe_accent` is the second line of defence, not the only one: a value that
 * reached the database could be read later by some consumer that forgets to
 * sanitise it, so it never gets there. `url(...)`, `var(...)` and anything
 * carrying a `;` are refused.
 */
const hex_colour = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected a hex colour such as #8a6516");

/**
 * Loose E.164. Deliberately not strict about country rules: a shopkeeper
 * mistyping their own number is their problem to see and fix, whereas a
 * validator that rejects a valid Indian landline is ours.
 */
const phone = z.string().regex(/^\+?[0-9][0-9 -]{7,18}[0-9]$/, "expected a phone number");

const optional_text = (max: number) => z.string().max(max).nullable();

/**
 * Note what is absent: `tenant_id`, `status`, `slug`, anything about pricing.
 * `.strict()` turns an attempt to supply one into a 422 rather than silently
 * ignoring it.
 */
export const update_settings_request = z
  .object({
    display_name: z.string().min(2).max(120).optional(),
    tagline: optional_text(160).optional(),
    accent_color: hex_colour.nullable().optional(),

    phone: phone.nullable().optional(),
    whatsapp: phone.nullable().optional(),
    email: z.email().max(200).nullable().optional(),
    address_line1: optional_text(160).optional(),
    address_line2: optional_text(160).optional(),
    city: optional_text(80).optional(),
    state: optional_text(80).optional(),
    pincode: z
      .string()
      .regex(/^[0-9]{6}$/, "expected a 6-digit PIN code")
      .nullable()
      .optional(),

    show_phone: z.boolean().optional(),
    show_whatsapp: z.boolean().optional(),
    show_address: z.boolean().optional(),
  })
  .strict();

export type UpdateSettingsRequest = z.infer<typeof update_settings_request>;

export interface TenantContactSettings {
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  readonly show_phone: boolean;
  readonly show_whatsapp: boolean;
  readonly show_address: boolean;
}

export interface TenantSettings {
  readonly display_name: string;
  readonly tagline: string | null;
  readonly accent_color: string | null;
  readonly has_logo: boolean;
  readonly contact: TenantContactSettings;
}

/** A shop with no contact row yet. Shown as blank, not as missing. */
export const EMPTY_CONTACT: TenantContactSettings = {
  phone: null,
  whatsapp: null,
  email: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  pincode: null,
  show_phone: true,
  show_whatsapp: true,
  show_address: true,
};

/**
 * Fields permitted in an audited snapshot.
 *
 * The same allowlist discipline the pricing audit uses: a column added later
 * cannot reach the audit log unless someone puts it here deliberately. Audit
 * rows are durable and readable across a tenant, so what goes in is a decision,
 * not a default.
 *
 * `address_line1` and `address_line2` are deliberately omitted — the city,
 * state and PIN code identify a change of premises without copying a street
 * address into a durable log.
 */
export const AUDITABLE_SETTINGS_FIELDS = [
  "display_name",
  "tagline",
  "accent_color",
  "phone",
  "whatsapp",
  "email",
  "city",
  "state",
  "pincode",
  "show_phone",
  "show_whatsapp",
  "show_address",
] as const;

export function to_snapshot(settings: TenantSettings): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    display_name: settings.display_name,
    tagline: settings.tagline,
    accent_color: settings.accent_color,
    ...settings.contact,
  };

  return Object.fromEntries(
    AUDITABLE_SETTINGS_FIELDS.filter((f) => f in flat).map((f) => [f, flat[f]]),
  );
}

/**
 * Map request fields onto branding columns.
 *
 * Built key by key rather than spread: a field the request did not mention must
 * not be written as `undefined`, and a future column must not become settable
 * simply by appearing in the schema.
 */
export function pick_branding(input: UpdateSettingsRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.display_name !== undefined) out["display_name"] = input.display_name;
  if (input.tagline !== undefined) out["tagline"] = input.tagline;
  if (input.accent_color !== undefined) out["accent_color"] = input.accent_color;
  return out;
}

/** As `pick_branding`, for the contacts table. Column names differ from fields. */
export function pick_contact(input: UpdateSettingsRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.phone !== undefined) out["phone_e164"] = input.phone;
  if (input.whatsapp !== undefined) out["whatsapp_e164"] = input.whatsapp;
  if (input.email !== undefined) out["public_email"] = input.email;
  if (input.address_line1 !== undefined) out["address_line1"] = input.address_line1;
  if (input.address_line2 !== undefined) out["address_line2"] = input.address_line2;
  if (input.city !== undefined) out["city"] = input.city;
  if (input.state !== undefined) out["state"] = input.state;
  if (input.pincode !== undefined) out["pincode"] = input.pincode;
  if (input.show_phone !== undefined) out["show_phone"] = input.show_phone;
  if (input.show_whatsapp !== undefined) out["show_whatsapp"] = input.show_whatsapp;
  if (input.show_address !== undefined) out["show_address"] = input.show_address;
  return out;
}
