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
 * It writes `tenant_branding` and `tenant_contacts` for the caller's own
 * tenant, through `with_context`, under RLS. It does not touch pricing — a
 * margin is a different decision with a different capability — and it cannot
 * reach another tenant, because the context comes from the verified token and
 * nothing in the request names a tenant.
 *
 * The shapes, validation and field mapping live in `tenant_settings_dto.ts`,
 * which needs no database and is unit-tested directly. What remains here is
 * the transaction, which is only meaningful against a real one.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../platform/errors.js";
import { require_capability } from "../auth/authorization.js";
import {
  actor_from_context,
  write_audit,
  type AuditRequestContext,
} from "../audit/audit_service.js";
import type { AuthenticatedTenantContext } from "../tenancy/tenant_context.js";
import { with_context } from "../tenancy/tenant_context.js";
import {
  EMPTY_CONTACT,
  pick_branding,
  pick_contact,
  to_snapshot,
  type TenantSettings,
  type UpdateSettingsRequest,
} from "./tenant_settings_dto.js";

export {
  update_settings_request,
  type TenantSettings,
  type UpdateSettingsRequest,
} from "./tenant_settings_dto.js";

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
    // The path is an internal storage location and never leaves; whether one
    // exists is all the dashboard needs to know.
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
