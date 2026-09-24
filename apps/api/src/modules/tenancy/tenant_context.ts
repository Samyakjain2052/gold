/**
 * Tenant identity.
 *
 * ## The rule
 *
 * `tenant_id` is **derived, never accepted**. Nothing in this module takes a
 * tenant id as an argument from a caller who could be relaying browser input.
 * There are exactly two derivations:
 *
 * 1. **Authenticated** — a verified principal (Supabase `sub`) is looked up in
 *    `tenant_users`. The membership row, not the request, decides the tenant.
 * 2. **Public** — an active `customer_links.slug` resolves to a tenant server
 *    side. The slug is a lookup key, not an authorisation claim.
 *
 * A request therefore cannot *express* which tenant it wants to act as. A
 * `tenant_id` in a body, query string or header has nowhere to go: no function
 * here reads one.
 *
 * ## Why the public path is separate
 *
 * The public context is not a weaker authenticated context — it is a different
 * authorisation model, and reusing the shopkeeper path with a "skip auth" flag
 * is how private fields leak to anonymous visitors. `PublicTenantContext`
 * carries no user, no role, and grants access only through the allowlist
 * projections in `modules/public`.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export type TenantRole = "owner" | "manager" | "staff";

/** A shopkeeper acting on their own tenant. */
export interface AuthenticatedTenantContext {
  readonly kind: "authenticated";
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role: TenantRole;
}

/** An anonymous visitor reading one tenant's published data. */
export interface PublicTenantContext {
  readonly kind: "public";
  readonly tenant_id: string;
  readonly slug: string;
}

/** A platform operator. Never scoped to a tenant; has its own guarded routes. */
export interface PlatformAdminContext {
  readonly kind: "platform_admin";
  readonly user_id: string;
}

export type TenantContext =
  | AuthenticatedTenantContext
  | PublicTenantContext
  | PlatformAdminContext;

export class TenantContextError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_membership"
      | "tenant_suspended"
      | "slug_not_found"
      | "slug_revoked",
  ) {
    super(message);
    this.name = "TenantContextError";
  }
}

/**
 * A principal produced by verifying a token. Never constructed from a body.
 *
 * Structurally a subset of `modules/auth`'s `VerifiedPrincipal`, so the auth
 * module's output satisfies this without the tenancy module depending on it.
 *
 * The user key is `external_object_id` + `directory_tenant_id` (Entra's `oid` +
 * `tid`), never `sub` — Entra subjects are pairwise per application. See
 * modules/auth/principal.ts.
 *
 * Note what is absent: OUR tenant. A token cannot assert one.
 */
export interface VerifiedPrincipal {
  readonly external_object_id: string;
  readonly directory_tenant_id: string;
}

/** Why a principal could not be turned into a context. */
export interface PrincipalIdentityRow {
  user_id: string;
  is_platform_admin: boolean;
  tenant_id: string | null;
  member_role: TenantRole | null;
  tenant_status: "pending" | "active" | "suspended" | null;
}

/**
 * Resolve a verified principal into the context it is entitled to.
 *
 * **The single trusted producer of an authenticated context.** Everything it
 * returns comes from the verified `sub` plus database state; no caller-supplied
 * value influences the outcome, because no caller-supplied value reaches it.
 *
 * Platform admin takes precedence over tenant membership: an operator who also
 * happens to own a shop acts as one or the other, never both at once. Which one
 * is decided here, once, rather than at each call site.
 */
export async function derive_principal_context(
  db: PrismaClient,
  principal: VerifiedPrincipal,
): Promise<AuthenticatedTenantContext | PlatformAdminContext> {
  const rows = await db.$queryRaw<PrincipalIdentityRow[]>`
    SELECT user_id, is_platform_admin, tenant_id, member_role, tenant_status
      FROM resolve_principal_identity(
        ${principal.external_object_id}::uuid,
        ${principal.directory_tenant_id}::uuid
      )
  `;

  const identity = rows[0];

  if (identity === undefined) {
    throw new TenantContextError(
      "principal is not a known user",
      "no_membership",
    );
  }

  if (identity.is_platform_admin) {
    return { kind: "platform_admin", user_id: identity.user_id };
  }

  if (identity.tenant_id === null || identity.member_role === null) {
    throw new TenantContextError(
      "principal has no tenant membership",
      "no_membership",
    );
  }

  if (identity.tenant_status === "suspended") {
    throw new TenantContextError("tenant is suspended", "tenant_suspended");
  }

  return {
    kind: "authenticated",
    tenant_id: identity.tenant_id,
    user_id: identity.user_id,
    role: identity.member_role,
  };
}

interface MembershipRow {
  tenant_id: string;
  user_id: string;
  member_role: TenantRole;
  tenant_status: "pending" | "active" | "suspended";
}

/**
 * Resolve the tenant a verified principal belongs to.
 *
 * Uses the `resolve_tenant_membership` SECURITY DEFINER function rather than a
 * direct query. `tenant_users` is RLS-protected, and this lookup runs *before*
 * any tenant context exists — a direct read would correctly return zero rows
 * and the application could never bootstrap. The function is narrow by design:
 * it accepts a principal, never a tenant id, so it cannot be used to enumerate
 * tenants. See migration 20260920170000_context_resolvers.
 */
export async function derive_authenticated_context(
  db: PrismaClient,
  principal: VerifiedPrincipal,
): Promise<AuthenticatedTenantContext> {
  const rows = await db.$queryRaw<MembershipRow[]>`
    SELECT tenant_id, user_id, member_role, tenant_status
      FROM resolve_tenant_membership(
        ${principal.external_object_id}::uuid,
        ${principal.directory_tenant_id}::uuid
      )
  `;

  const membership = rows[0];

  if (membership === undefined) {
    throw new TenantContextError(
      "principal has no tenant membership",
      "no_membership",
    );
  }
  if (membership.tenant_status === "suspended") {
    throw new TenantContextError("tenant is suspended", "tenant_suspended");
  }

  return {
    kind: "authenticated",
    tenant_id: membership.tenant_id,
    user_id: membership.user_id,
    role: membership.member_role,
  };
}

/**
 * Resolve a public slug to a tenant.
 *
 * A revoked slug is distinguished from an unknown one so an old shared link can
 * say "this link was replaced" instead of silently resolving elsewhere. Neither
 * outcome reveals whether the tenant exists.
 */
interface PublicLinkRow {
  tenant_id: string;
  slug: string;
  is_active: boolean;
  tenant_status: "pending" | "active" | "suspended";
}

export async function derive_public_context(
  db: PrismaClient,
  slug: string,
): Promise<PublicTenantContext> {
  const normalised = slug.trim().toLowerCase();

  // Same bootstrapping reason as above: `customer_links` is RLS-protected and
  // this lookup is what decides the context. The function takes a slug only.
  const rows = await db.$queryRaw<PublicLinkRow[]>`
    SELECT tenant_id, slug, is_active, tenant_status
      FROM resolve_public_link(${normalised})
  `;

  const link = rows[0];

  if (link === undefined) {
    throw new TenantContextError("no such customer link", "slug_not_found");
  }
  if (!link.is_active) {
    throw new TenantContextError("customer link was revoked", "slug_revoked");
  }
  // A suspended tenant is indistinguishable from a missing one to the public.
  if (link.tenant_status !== "active") {
    throw new TenantContextError("no such customer link", "slug_not_found");
  }

  return { kind: "public", tenant_id: link.tenant_id, slug: link.slug };
}

/** Narrow a context to one that carries a tenant. */
export function tenant_id_of(context: TenantContext): string {
  if (context.kind === "platform_admin") {
    throw new TenantContextError(
      "platform admin context is not tenant-scoped",
      "no_membership",
    );
  }
  return context.tenant_id;
}

const ROLE_RANK: Readonly<Record<TenantRole, number>> = {
  owner: 3,
  manager: 2,
  staff: 1,
};

/**
 * Role check for the service layer.
 *
 * `backend-standards.md` §5: permission is checked *before* resource existence,
 * so a cross-tenant probe cannot be used to enumerate what exists.
 */
export function has_role(context: TenantContext, required: TenantRole): boolean {
  if (context.kind !== "authenticated") return false;
  return ROLE_RANK[context.role] >= ROLE_RANK[required];
}

/**
 * Run `work` inside a transaction bound to this context's tenant.
 *
 * `set_config(..., TRUE)` scopes the setting to the transaction, so a pooled
 * connection cannot leak one tenant's context into the next request.
 */
export async function with_context<T>(
  db: PrismaClient,
  context: AuthenticatedTenantContext | PublicTenantContext,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return with_tenant_context(db, context.tenant_id, work);
}

/**
 * Run `work` under a tenant id that was derived server-side.
 *
 * `with_context` is the form every request path uses, and it exists precisely
 * so that a tenant is taken from a verified context rather than named directly.
 * This variant takes the id itself, for the one caller that legitimately has no
 * request context: the publication pipeline.
 *
 * A market tick moves every tenant selling that metal, so the pipeline iterates
 * tenants. The ids it iterates come from `tenants_affected_by_metal`, a
 * SECURITY DEFINER query over the database — never from a request, a header or
 * a body. Each tenant's work then runs under RLS exactly as a request would;
 * nothing here bypasses a policy.
 *
 * **Do not call this from an HTTP handler.** A route that has a tenant id to
 * pass has taken it from somewhere, and that somewhere is the client.
 */
export async function with_tenant_context<T>(
  db: PrismaClient,
  tenant_id: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant_id}, TRUE)`;
    return work(tx);
  });
}
