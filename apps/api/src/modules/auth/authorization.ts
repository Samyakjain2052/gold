/**
 * Authorization.
 *
 * Authentication answers *who*. This answers *what they may do*. A valid token
 * is never sufficient on its own — `authenticated = authorized` is the mistake
 * this module exists to prevent.
 *
 * ## The three contexts are not interchangeable
 *
 * | Context | Produced by | May do |
 * |---|---|---|
 * | `AuthenticatedTenantContext` | verified JWT → membership lookup | Tenant operations, within its own tenant, subject to role |
 * | `PlatformAdminContext` | verified JWT → `platform_admins` lookup | Platform operations only |
 * | `PublicTenantContext` | validated public slug | Published public data only |
 *
 * The separations that matter:
 *
 * - **A platform admin is not a super-shopkeeper.** It gets no tenant
 *   operations at all — not even read. Platform work goes through platform
 *   endpoints against aggregate views. Letting an admin context satisfy a
 *   tenant check would make every tenant guard conditional on a role string,
 *   which is precisely the confusion that produces cross-tenant access.
 * - **A public context is not a weak shopkeeper.** It can never reach a tenant
 *   operation, so a public page cannot become a side door into the dashboard.
 * - **A shopkeeper is not an admin.** A valid shopkeeper token grants no
 *   platform capability whatsoever.
 */
import type {
  TenantContext,
  TenantRole,
} from "../tenancy/tenant_context.js";

/**
 * Capabilities, named by what they let someone do rather than by endpoint, so
 * the matrix stays readable as routes come and go.
 */
export type Capability =
  // Tenant-scoped
  | "tenant:read"
  | "tenant:pricing:read"
  | "tenant:pricing:write"
  | "tenant:pricing:delete"
  | "tenant:branding:write"
  | "tenant:link:rotate"
  | "tenant:audit:read"
  | "tenant:realtime:subscribe"
  // Platform-scoped
  | "platform:tenants:read"
  | "platform:tenants:suspend"
  | "platform:health:read"
  | "platform:audit:read"
  // Public
  | "public:rates:read"
  | "public:realtime:subscribe";

/** Minimum tenant role for each tenant capability. */
const TENANT_CAPABILITIES: Readonly<Partial<Record<Capability, TenantRole>>> = {
  "tenant:read": "staff",
  "tenant:pricing:read": "staff",
  "tenant:realtime:subscribe": "staff",
  "tenant:audit:read": "manager",
  "tenant:pricing:write": "manager",
  "tenant:branding:write": "manager",
  // Destructive and identity-affecting operations are owner-only.
  "tenant:pricing:delete": "owner",
  "tenant:link:rotate": "owner",
};

const PLATFORM_CAPABILITIES: readonly Capability[] = [
  "platform:tenants:read",
  "platform:tenants:suspend",
  "platform:health:read",
  "platform:audit:read",
];

const PUBLIC_CAPABILITIES: readonly Capability[] = [
  "public:rates:read",
  "public:realtime:subscribe",
];

const ROLE_RANK: Readonly<Record<TenantRole, number>> = {
  owner: 3,
  manager: 2,
  staff: 1,
};

/**
 * Whether `context` holds `capability`.
 *
 * Deliberately total and exhaustive: every context kind is handled explicitly,
 * and the default is denial.
 */
export function can(context: TenantContext, capability: Capability): boolean {
  switch (context.kind) {
    case "platform_admin":
      // Platform capabilities only. A platform admin never satisfies a tenant
      // capability, however privileged it sounds.
      return PLATFORM_CAPABILITIES.includes(capability);

    case "authenticated": {
      // A shopkeeper never holds a platform capability.
      if (PLATFORM_CAPABILITIES.includes(capability)) return false;
      // Nor a public-only one; public reads go through the public path.
      if (PUBLIC_CAPABILITIES.includes(capability)) return false;

      const required = TENANT_CAPABILITIES[capability];
      if (required === undefined) return false;
      return ROLE_RANK[context.role] >= ROLE_RANK[required];
    }

    case "public":
      return PUBLIC_CAPABILITIES.includes(capability);
  }
}

export class AuthorizationError extends Error {
  constructor(
    readonly capability: Capability,
    readonly context_kind: TenantContext["kind"],
  ) {
    // The message names the capability, not the resource — it must not confirm
    // that a resource the caller cannot reach exists.
    super(`not permitted: ${capability}`);
    this.name = "AuthorizationError";
  }
}

/** Throwing form for service entry points. */
export function require_capability(
  context: TenantContext,
  capability: Capability,
): void {
  if (!can(context, capability)) {
    throw new AuthorizationError(capability, context.kind);
  }
}

/**
 * Narrow to a tenant-acting context.
 *
 * Rejects `platform_admin` and `public` — neither may perform tenant
 * operations, so neither can be silently treated as one.
 */
export function require_tenant_actor(
  context: TenantContext,
): Extract<TenantContext, { kind: "authenticated" }> {
  if (context.kind !== "authenticated") {
    throw new AuthorizationError("tenant:read", context.kind);
  }
  return context;
}

export function require_platform_admin(
  context: TenantContext,
): Extract<TenantContext, { kind: "platform_admin" }> {
  if (context.kind !== "platform_admin") {
    throw new AuthorizationError("platform:tenants:read", context.kind);
  }
  return context;
}

/** Every capability, for exhaustiveness tests and documentation. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  ...Object.keys(TENANT_CAPABILITIES),
  ...PLATFORM_CAPABILITIES,
  ...PUBLIC_CAPABILITIES,
] as Capability[];
