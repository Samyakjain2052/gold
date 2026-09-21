/**
 * The authorization matrix.
 *
 * Authentication says *who*; this says *what they may do*. The tests that
 * matter most are the negative ones — a valid token granting nothing it should
 * not.
 */
import { describe, expect, test } from "vitest";
import {
  can,
  require_capability,
  require_platform_admin,
  require_tenant_actor,
  AuthorizationError,
  ALL_CAPABILITIES,
  type Capability,
} from "../../src/modules/auth/authorization.js";
import type {
  AuthenticatedTenantContext,
  PlatformAdminContext,
  PublicTenantContext,
  TenantRole,
} from "../../src/modules/tenancy/tenant_context.js";

const TENANT_A = "a1b2c3d4-1111-4111-8111-1111111111ff";

function shopkeeper(role: TenantRole): AuthenticatedTenantContext {
  return {
    kind: "authenticated",
    tenant_id: TENANT_A,
    user_id: "33333333-3333-4333-8333-333333333333",
    role,
  };
}

const admin: PlatformAdminContext = {
  kind: "platform_admin",
  user_id: "44444444-4444-4444-8444-444444444444",
};

const public_visitor: PublicTenantContext = {
  kind: "public",
  tenant_id: TENANT_A,
  slug: "sharma-jewellers",
};

const TENANT_CAPS: readonly Capability[] = [
  "tenant:read",
  "tenant:pricing:read",
  "tenant:pricing:write",
  "tenant:pricing:delete",
  "tenant:branding:write",
  "tenant:link:rotate",
  "tenant:audit:read",
  "tenant:realtime:subscribe",
];

const PLATFORM_CAPS: readonly Capability[] = [
  "platform:tenants:read",
  "platform:tenants:suspend",
  "platform:health:read",
  "platform:audit:read",
];

const PUBLIC_CAPS: readonly Capability[] = [
  "public:rates:read",
  "public:realtime:subscribe",
];

describe("role hierarchy within a tenant", () => {
  test.each([
    ["staff", "tenant:read", true],
    ["staff", "tenant:pricing:read", true],
    ["staff", "tenant:realtime:subscribe", true],
    ["staff", "tenant:pricing:write", false],
    ["staff", "tenant:branding:write", false],
    ["staff", "tenant:audit:read", false],
    ["staff", "tenant:pricing:delete", false],
    ["manager", "tenant:pricing:write", true],
    ["manager", "tenant:branding:write", true],
    ["manager", "tenant:audit:read", true],
    ["manager", "tenant:pricing:delete", false],
    ["manager", "tenant:link:rotate", false],
    ["owner", "tenant:pricing:delete", true],
    ["owner", "tenant:link:rotate", true],
    ["owner", "tenant:pricing:write", true],
  ])("Can_%s_%s_is_%s", (role, capability, expected) => {
    expect(can(shopkeeper(role as TenantRole), capability as Capability)).toBe(
      expected,
    );
  });

  test("Can_ownerHoldsEveryTenantCapability", () => {
    for (const capability of TENANT_CAPS) {
      expect(can(shopkeeper("owner"), capability), capability).toBe(true);
    }
  });
});

describe("a shopkeeper is not a platform admin", () => {
  /** The headline separation: a valid shopkeeper token grants nothing platform-wide. */
  test.each(PLATFORM_CAPS)(
    "Can_shopkeeperOwner_%s_isDenied",
    (capability: Capability) => {
      expect(can(shopkeeper("owner"), capability)).toBe(false);
    },
  );

  test("RequirePlatformAdmin_shopkeeper_throws", () => {
    expect(() => require_platform_admin(shopkeeper("owner"))).toThrow(
      AuthorizationError,
    );
  });

  test("Can_shopkeeper_holdsNoPublicOnlyCapability", () => {
    // Public reads go through the public path, not the dashboard one.
    for (const capability of PUBLIC_CAPS) {
      expect(can(shopkeeper("owner"), capability), capability).toBe(false);
    }
  });
});

describe("a platform admin is not a super-shopkeeper", () => {
  /**
   * An admin gets no tenant operation at all — not even read. Letting an admin
   * context satisfy a tenant check would make every tenant guard conditional on
   * a role string, which is exactly the confusion that produces cross-tenant
   * access.
   */
  test.each(TENANT_CAPS)("Can_platformAdmin_%s_isDenied", (capability: Capability) => {
    expect(can(admin, capability)).toBe(false);
  });

  test("Can_platformAdmin_holdsEveryPlatformCapability", () => {
    for (const capability of PLATFORM_CAPS) {
      expect(can(admin, capability), capability).toBe(true);
    }
  });

  test("RequireTenantActor_platformAdmin_throws", () => {
    expect(() => require_tenant_actor(admin)).toThrow(AuthorizationError);
  });

  test("Can_platformAdmin_cannotSubscribeToATenantRealtimeChannel", () => {
    expect(can(admin, "tenant:realtime:subscribe")).toBe(false);
  });
});

describe("a public visitor is not a weak shopkeeper", () => {
  test.each(TENANT_CAPS)("Can_publicVisitor_%s_isDenied", (capability: Capability) => {
    expect(can(public_visitor, capability)).toBe(false);
  });

  test.each(PLATFORM_CAPS)(
    "Can_publicVisitor_%s_isDenied",
    (capability: Capability) => {
      expect(can(public_visitor, capability)).toBe(false);
    },
  );

  test("Can_publicVisitor_holdsOnlyPublicCapabilities", () => {
    for (const capability of PUBLIC_CAPS) {
      expect(can(public_visitor, capability), capability).toBe(true);
    }
  });

  /** A public page must never become a side door into the dashboard. */
  test("RequireTenantActor_publicVisitor_throws", () => {
    expect(() => require_tenant_actor(public_visitor)).toThrow(AuthorizationError);
  });

  test("RequirePlatformAdmin_publicVisitor_throws", () => {
    expect(() => require_platform_admin(public_visitor)).toThrow(AuthorizationError);
  });
});

describe("require_capability", () => {
  test("RequireCapability_permitted_doesNotThrow", () => {
    expect(() =>
      require_capability(shopkeeper("manager"), "tenant:pricing:write"),
    ).not.toThrow();
  });

  test("RequireCapability_denied_throwsAuthorizationError", () => {
    expect(() =>
      require_capability(shopkeeper("staff"), "tenant:pricing:write"),
    ).toThrow(AuthorizationError);
  });

  /** The message must not confirm that a resource exists. */
  test("RequireCapability_errorMessage_namesTheCapabilityNotAResource", () => {
    try {
      require_capability(shopkeeper("staff"), "tenant:pricing:delete");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as AuthorizationError).message).toBe(
        "not permitted: tenant:pricing:delete",
      );
      expect((error as AuthorizationError).message).not.toContain(TENANT_A);
    }
  });

  test("RequireCapability_recordsCapabilityAndContextKind", () => {
    try {
      require_capability(admin, "tenant:pricing:write");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as AuthorizationError).capability).toBe("tenant:pricing:write");
      expect((error as AuthorizationError).context_kind).toBe("platform_admin");
    }
  });
});

describe("matrix completeness", () => {
  /** Every capability is classified; none is accidentally unreachable. */
  test("Matrix_everyCapability_isGrantedToExactlyOneContextKind", () => {
    for (const capability of ALL_CAPABILITIES) {
      const holders = [
        can(shopkeeper("owner"), capability),
        can(admin, capability),
        can(public_visitor, capability),
      ].filter(Boolean).length;

      expect(holders, `${capability} should have exactly one holder kind`).toBe(1);
    }
  });

  test("Matrix_capabilityListsAreDisjoint", () => {
    const all = [...TENANT_CAPS, ...PLATFORM_CAPS, ...PUBLIC_CAPS];
    expect(new Set(all).size).toBe(all.length);
  });

  test("Matrix_allCapabilities_coversEveryDeclaredCapability", () => {
    expect([...ALL_CAPABILITIES].sort()).toEqual(
      [...TENANT_CAPS, ...PLATFORM_CAPS, ...PUBLIC_CAPS].sort(),
    );
  });

  /** An unknown capability string is denied, never silently permitted. */
  test("Can_unknownCapability_isDeniedForEveryContext", () => {
    const bogus = "tenant:everything" as Capability;
    expect(can(shopkeeper("owner"), bogus)).toBe(false);
    expect(can(admin, bogus)).toBe(false);
    expect(can(public_visitor, bogus)).toBe(false);
  });
});
