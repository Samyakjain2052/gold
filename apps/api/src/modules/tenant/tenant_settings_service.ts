/**
 * The shop's own settings: how it presents itself, and how customers reach it.
 *
 * Until now a shop was stuck with whatever onboarding gave it — its name could
 * not change, it had no contact details, and the market-rate breakdown could
 * never be switched on. Everything a shopkeeper can say about their shop, short
 * of a logo, lives here.
 *
 * ## What this deliberately cannot do
 *
 * It writes `tenant_branding`, `tenant_contacts` and `tenant_products` for the
 * caller's own tenant, through `with_context`, under RLS. It does not touch
 * pricing — a margin is a different decision with a different capability — and
 * it cannot reach another tenant, because the context comes from the verified
 * token and nothing in the request names a tenant.
 *
 * ## Validation is not cosmetic here
 *
 * `accent_color` is rendered into a style attribute on a public page, so it is
 * constrained to a plain hex literal on the way in as well as on the way out.
 * The frontend's `safe_accent` is the second line, not the only one: a value
 * that reached the database could be read by some future consumer that forgets
 * to sanitise it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../../platform/errors.js";
import { require_capability } from "../auth/authorization.js";
import {
  actor_from_context,
  write_audit,
  type AuditRequestContext,
} from "../audit/audit_service.js";
import type { AuthenticatedTenantContext } from "../tenancy/tenant_context.js";
import { with_context } from "../tenancy/tenant_context.js";

/** A plain hex colour. Anything else — `url()`, a variable — is refused. */
const hex_colour = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected a hex colour such as #8a6516");

/**
 * Loose E.164. Deliberately not strict about country rules: a shopkeeper
 * mistyping their own number is their problem to see and fix, whereas a
 * validator that rejects a valid Indian landline is ours.
 */
const phone = z
  .string()
  .regex(/^\+?[0-9][0-9 -]{7,18}[0-9]$/, "expected a phone number");

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
    pincode: z.string().regex(/^[0-9]{6}$/, "expected a 6-digit PIN code").nullable().optional(),

    show_phone: z.boolean().optional(),
    show_whatsapp: z.boolean().optional(),
    show_address: z.boolean().optional(),
  })
  .strict();

export type UpdateSettingsRequest = z.infer<typeof update_settings_request>;

export interface TenantSettings {
  readonly display_name: string;
  readonly tagline: string | null;
  readonly accent_color: string | null;
  readonly has_logo: boolean;
  readonly contact: {
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
  };
}

/**
 * Fields permitted in an audited snapshot.
 *
 * The same allowlist discipline the pricing audit uses: a column added later
 * cannot reach the audit log unless someone puts it here deliberately. Audit
 * rows are durable and readable across a tenant, so what goes in is a decision,
 * not a default.
 */
const AUDITABLE_SETTINGS_FIELDS = [
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

function to_snapshot(settings: TenantSettings): Record<string, unknown> {
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

const EMPTY_CONTACT = {
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
} as const;

async function read_settings(
  tx: Prisma.TransactionClient,
  tenant_id: string,
): Promise<TenantSettings> {
  const [branding, contact] = await Promise.all([
    tx.tenant_branding.findUnique({
      where: { tenant_id },
      select: {
        display_name: true,
        tagline: true,
        accent_color: true,
        logo_blob_path: true,
      },
    }),
    tx.tenant_contacts.findUnique({
      where: { tenant_id },
      select: {
        phone_e164: true,
        whatsapp_e164: true,
        public_email: true,
        address_line1: true,
        address_line2: true,
        city: true,
        state: true,
        pincode: true,
        show_phone: true,
        show_whatsapp: true,
        show_address: true,
      },
    }),
  ]);

  return {
    display_name: branding?.display_name ?? "",
    tagline: branding?.tagline ?? null,
    accent_color: branding?.accent_color ?? null,
    has_logo: branding?.logo_blob_path != null,
    contact:
      contact === null
        ? EMPTY_CONTACT
        : {
            phone: contact.phone_e164,
            whatsapp: contact.whatsapp_e164,
            email: contact.public_email,
            address_line1: contact.address_line1,
            address_line2: contact.address_line2,
            city: contact.city,
            state: contact.state,
            pincode: contact.pincode,
            show_phone: contact.show_phone,
            show_whatsapp: contact.show_whatsapp,
            show_address: contact.show_address,
          },
  };
}

export async function get_settings(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
): Promise<TenantSettings> {
  require_capability(context, "tenant:read");
  return with_context(db, context, (tx) => read_settings(tx, context.tenant_id));
}

/**
 * Apply a partial update.
 *
 * Only the keys present are changed. `null` clears a field; absent leaves it
 * alone — a distinction that matters because "remove my phone number" and
 * "don't touch my phone number" are different intentions and a form sends both.
 */
export async function update_settings(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  input: UpdateSettingsRequest,
  request: AuditRequestContext,
): Promise<TenantSettings> {
  require_capability(context, "tenant:branding:write");

  if (Object.keys(input).length === 0) {
    throw AppError.validation("No changes supplied");
  }

  return with_context(db, context, async (tx) => {
    const before = await read_settings(tx, context.tenant_id);

    const branding = pick_branding(input);
    if (Object.keys(branding).length > 0) {
      await tx.tenant_branding.upsert({
        where: { tenant_id: context.tenant_id },
        // A shop always has branding after onboarding, but an upsert keeps this
        // safe for a tenant created before onboarding existed.
        create: {
          tenant_id: context.tenant_id,
          ...branding,
          // Last, and never undefined: a branding row without a name is not a
          // shop, and the column does not accept one.
          display_name: (branding["display_name"] as string | undefined) ?? before.display_name,
        },
        update: branding,
      });
    }

    const contact = pick_contact(input);
    if (Object.keys(contact).length > 0) {
      await tx.tenant_contacts.upsert({
        where: { tenant_id: context.tenant_id },
        create: { tenant_id: context.tenant_id, ...contact },
        update: contact,
      });
    }

    const after = await read_settings(tx, context.tenant_id);

    await write_audit(tx, {
      tenant_id: context.tenant_id,
      actor: actor_from_context(context),
      action: "tenant_settings.updated",
      entity_type: "tenant",
      entity_id: context.tenant_id,
      old_value: to_snapshot(before),
      new_value: to_snapshot(after),
      request,
    });

    return after;
  });
}

/**
 * Map request fields onto branding columns.
 *
 * Built key by key rather than spread: a field the request did not mention must
 * not be written as `undefined`, and a future column must not become settable
 * simply by appearing in the schema.
 */
function pick_branding(input: UpdateSettingsRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.display_name !== undefined) out["display_name"] = input.display_name;
  if (input.tagline !== undefined) out["tagline"] = input.tagline;
  if (input.accent_color !== undefined) out["accent_color"] = input.accent_color;
  return out;
}

function pick_contact(input: UpdateSettingsRequest): Record<string, unknown> {
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
