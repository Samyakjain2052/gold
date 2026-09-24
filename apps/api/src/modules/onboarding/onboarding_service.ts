/**
 * Creating a shop for a shopkeeper who has just signed in.
 *
 * Until now a signed-in user with no `tenant_users` row got a `403` and had no
 * way out: the only shops that existed were seeded. This is the path from a
 * verified Entra identity to a working shop with a shareable customer link.
 *
 * ## The RLS bootstrapping problem, and how this avoids BYPASSRLS
 *
 * Every table involved is RLS-protected by `tenant_id = current_tenant_id()`,
 * including `tenants` itself. Creating a tenant therefore looks circular: the
 * policy needs a context that the row being inserted is supposed to establish.
 *
 * It is not circular, because **we choose the id**. The tenant's UUID is
 * generated first, `app.current_tenant_id` is set to it, and only then are the
 * rows inserted — so every `WITH CHECK (tenant_id = current_tenant_id())`
 * passes by construction.
 *
 * Nothing here holds `BYPASSRLS`, and no policy is relaxed. An onboarding
 * transaction can write exactly one tenant's rows: the one it is creating. It
 * could not reach an existing tenant's data even by accident, because the
 * context is pinned to a UUID that did not exist a moment ago.
 *
 * ## Atomicity
 *
 * A shop is seven rows across six tables. A partial shop — a tenant with no
 * owner, or an owner with no customer link — is worse than no shop, because the
 * user is then signed in, apparently onboarded, and permanently broken. One
 * transaction, or nothing.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { VerifiedPrincipal } from "../auth/principal.js";
import type { Logger } from "../../platform/logger.js";
import { CONSTRAINTS, violates_constraint } from "../../platform/prisma_errors.js";

/** Paths the router owns; a shop may not claim one. Mirrors the CHECK constraint. */
export const RESERVED_SLUGS: readonly string[] = [
  "api", "admin", "health", "auth", "login", "logout", "dashboard",
  "static", "assets", "public", "www", "app", "r", "settings", "help",
];

export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 49;

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly code: "already_onboarded" | "invalid_name" | "slug_unavailable",
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

/**
 * Turn a shop name into a candidate slug.
 *
 * Deliberately lossy: diacritics, punctuation and script outside `a-z0-9` are
 * dropped rather than transliterated. A shop named in Devanagari would reduce to
 * nothing, which `derive_slug` reports rather than papering over — the caller
 * then asks for a slug explicitly. Guessing a romanisation would produce a URL
 * the shopkeeper never chose and cannot easily change.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** Whether a slug satisfies the database's format and denylist. */
export function is_valid_slug(slug: string): boolean {
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) return false;
  if (RESERVED_SLUGS.includes(slug)) return false;
  return /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/.test(slug);
}

/**
 * Whether any link — active or revoked — already uses this slug.
 *
 * Asked through `resolve_public_link`, the SECURITY DEFINER resolver the public
 * page already uses, **not** a direct query. Onboarding runs with no tenant
 * context, so a direct `customer_links` read is filtered to nothing by RLS and
 * reports every slug as free. That is not a theoretical concern: it let two
 * shops claim the same name until the unique index rejected the second insert,
 * and it silently reassigned a revoked slug, which would have pointed an old
 * shared link at a different shop's rates.
 *
 * Revoked slugs count as taken, deliberately — that is what makes rotation a
 * revocation rather than a rename.
 */
async function slug_is_taken(db: PrismaClient, slug: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ slug: string }[]>`
    SELECT slug FROM resolve_public_link(${slug})
  `;
  return rows.length > 0;
}

/**
 * Pick an available slug.
 *
 * The database has the final say: the partial unique index over active links is
 * the real guarantee, and two shops onboarding at once can both pass this check
 * before either inserts. The caller maps that unique violation to a conflict.
 */
export async function find_available_slug(
  db: PrismaClient,
  preferred: string,
): Promise<string> {
  const base = is_valid_slug(preferred) ? preferred : "";
  if (base === "") {
    throw new OnboardingError(
      "could not derive a usable link from this name; choose one explicitly",
      "invalid_name",
    );
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : truncate_with_suffix(base, attempt + 1);
    if (!is_valid_slug(candidate)) continue;
    if (!(await slug_is_taken(db, candidate))) return candidate;
  }

  throw new OnboardingError(
    "that shop name is heavily taken; please choose a link explicitly",
    "slug_unavailable",
  );
}

/** `sharma-jewellers` + 2 → `sharma-jewellers-2`, trimmed to the length limit. */
function truncate_with_suffix(base: string, n: number): string {
  const suffix = `-${n}`;
  const room = MAX_SLUG_LENGTH - suffix.length;
  return `${base.slice(0, room).replace(/-+$/g, "")}${suffix}`;
}

export interface OnboardingRequest {
  readonly shop_name: string;
  /** Optional. Derived from the name when absent. */
  readonly slug?: string | undefined;
}

export interface OnboardingResult {
  readonly slug: string;
  readonly display_name: string;
  readonly products: number;
}

export interface OnboardingDependencies {
  readonly db: PrismaClient;
  readonly logger: Logger;
}

/**
 * Create a shop owned by this principal.
 *
 * Refuses if the principal already has a membership: onboarding twice would
 * leave a user owning two shops with no way to tell them apart, and is far more
 * likely to be a double-submitted form than a real intent.
 */
export async function onboard_shopkeeper(
  deps: OnboardingDependencies,
  principal: VerifiedPrincipal,
  request: OnboardingRequest,
): Promise<OnboardingResult> {
  const { db, logger } = deps;

  const display_name = request.shop_name.trim();
  if (display_name.length < 2 || display_name.length > 120) {
    throw new OnboardingError("shop name must be 2–120 characters", "invalid_name");
  }

  const existing = await db.$queryRaw<{ tenant_id: string | null }[]>`
    SELECT tenant_id FROM resolve_principal_identity(
      ${principal.external_object_id}::uuid,
      ${principal.directory_tenant_id}::uuid
    )
  `;

  if (existing[0]?.tenant_id != null) {
    throw new OnboardingError("this account already has a shop", "already_onboarded");
  }

  const requested = request.slug?.trim().toLowerCase();
  if (requested !== undefined && requested !== "" && !is_valid_slug(requested)) {
    throw new OnboardingError(
      "that link is not usable; use lowercase letters, numbers and hyphens",
      "invalid_name",
    );
  }

  const slug = await find_available_slug(
    db,
    requested !== undefined && requested !== "" ? requested : slugify(display_name),
  );

  // Chosen before the transaction so the RLS context can be pinned to it.
  const tenant_id = randomUUID();

  let products: number;
  try {
    products = await create_shop(db, tenant_id, principal, display_name, slug);
  } catch (error) {
    // Two shopkeepers onboarding with the same name in the same instant both
    // pass the availability check; the unique index decides. That is a
    // conflict, not a server error.
    if (violates_constraint(error, CONSTRAINTS.active_customer_link)) {
      throw new OnboardingError(
        "that link was just taken; please choose another",
        "slug_unavailable",
      );
    }
    throw error;
  }

  logger.info(
    { event: "onboarding.completed", slug, products },
    `created shop "${display_name}" with ${products} product(s)`,
  );

  return { slug, display_name, products };
}

async function create_shop(
  db: PrismaClient,
  tenant_id: string,
  principal: VerifiedPrincipal,
  display_name: string,
  slug: string,
): Promise<number> {
  return db.$transaction(async (tx) => {
    // Everything below is inserted under this context, so each policy's
    // WITH CHECK passes against the tenant being created and no other.
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant_id}, TRUE)`;

    // `users` carries no tenant_id and no RLS: an identity exists before it
    // belongs anywhere. Upserted because a user may have signed in, failed
    // onboarding, and returned.
    const user = await upsert_user(tx, principal, display_name);

    await tx.tenants.create({
      data: { id: tenant_id, legal_name: display_name, status: "active" },
    });

    await tx.tenant_users.create({
      data: { tenant_id, user_id: user.id, role: "owner" },
    });

    await tx.tenant_branding.create({
      data: { tenant_id, display_name, accent_color: "#8a6516" },
    });

    await tx.customer_links.create({
      data: { tenant_id, slug, created_by: user.id },
    });

    return enable_default_products(tx, tenant_id, user.id);
  });
}

async function upsert_user(
  tx: Prisma.TransactionClient,
  principal: VerifiedPrincipal,
  display_name: string,
) {
  /**
   * `users.email` is an internal key, not a mailbox.
   *
   * The verified principal carries no email claim — Stage 5 deliberately keys
   * users on `oid`+`tid` and exposes nothing else — and accepting one from the
   * request body would let a caller claim an address that is unique in our
   * table but unproven. `.invalid` is reserved by RFC 2606 and can never be
   * routed, so this cannot be mistaken for a contact address. A shop's real,
   * publishable email lives on `tenant_contacts`.
   */
  const email = `${principal.external_object_id}@users.invalid`;

  return tx.users.upsert({
    where: {
      external_directory_id_external_object_id: {
        external_directory_id: principal.directory_tenant_id,
        external_object_id: principal.external_object_id,
      },
    },
    create: {
      email,
      full_name: display_name,
      external_directory_id: principal.directory_tenant_id,
      external_object_id: principal.external_object_id,
    },
    update: {},
    select: { id: true },
  });
}

/**
 * Enable the catalogue with a zero adjustment.
 *
 * Zero, not a guessed margin: what a shop charges over market is the one number
 * only they can supply, and inventing one would publish a price they never
 * chose. The products are enabled so the page is populated and the dashboard
 * has rules to edit from the first visit.
 */
async function enable_default_products(
  tx: Prisma.TransactionClient,
  tenant_id: string,
  user_id: string,
): Promise<number> {
  const products = await tx.products.findMany({
    where: { is_active: true },
    select: { id: true, metal_code: true, sort_order: true },
    orderBy: { sort_order: "asc" },
  });

  for (const [index, product] of products.entries()) {
    await tx.tenant_products.create({
      data: {
        tenant_id,
        product_id: product.id,
        is_enabled: true,
        display_order: index,
        // The conventional Indian retail units.
        display_unit: product.metal_code === "SILVER" ? "per_kilogram" : "per_10_gram",
        // Off by default: a shop publishes its margin only if it chooses to.
        show_base_rate: false,
      },
    });

    await tx.tenant_pricing_rules.create({
      data: {
        tenant_id,
        product_id: product.id,
        adjustment_kind: "absolute",
        adjustment_value: 0n,
        rounding_step_paise: 100,
        rounding_mode: "half_up",
        component_precision_paise: 1,
        is_active: true,
        created_by: user_id,
        updated_by: user_id,
      },
    });
  }

  return products.length;
}
