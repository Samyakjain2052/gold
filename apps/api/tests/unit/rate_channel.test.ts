/**
 * Subscription authorisation and channel naming — the security-critical half of
 * the realtime layer, and pure, so it is tested here rather than against Redis.
 *
 * Actual delivery isolation (publish to A, assert B receives nothing) needs a
 * real broker and lives in `tests/integration/realtime_isolation.test.ts`.
 */
import { describe, expect, test } from "vitest";
import {
  assert_can_subscribe,
  authorize_subscription,
  channel_for,
  CHANNEL_PREFIX,
  RealtimeAuthorizationError,
} from "../../src/modules/realtime/rate_channel.js";
import type {
  AuthenticatedTenantContext,
  PlatformAdminContext,
  PublicTenantContext,
} from "../../src/modules/tenancy/tenant_context.js";

const TENANT_A = "a1b2c3d4-1111-4111-8111-1111111111ff";
const TENANT_B = "b2c3d4e5-2222-4222-8222-2222222222ee";

const authenticated_a: AuthenticatedTenantContext = {
  kind: "authenticated",
  tenant_id: TENANT_A,
  user_id: "33333333-3333-4333-8333-333333333333",
  role: "owner",
};

const public_a: PublicTenantContext = {
  kind: "public",
  tenant_id: TENANT_A,
  slug: "sharma-jewellers",
};

const admin: PlatformAdminContext = {
  kind: "platform_admin",
  user_id: "44444444-4444-4444-8444-444444444444",
};

describe("channel naming", () => {
  test("ChannelFor_tenant_isNamespaced", () => {
    expect(channel_for(TENANT_A)).toBe(`${CHANNEL_PREFIX}${TENANT_A}`);
  });

  test("ChannelFor_differentTenants_produceDifferentChannels", () => {
    expect(channel_for(TENANT_A)).not.toBe(channel_for(TENANT_B));
  });

  /**
   * There is no broadcast or wildcard channel by construction. A pattern that
   * could match several tenants must not be expressible as a channel name.
   */
  test.each([
    ["wildcard", "*"],
    ["glob pattern", "rates:tenant:*"],
    ["empty", ""],
    ["word", "all"],
    ["path traversal", "../admin"],
    ["injection", "a'; DROP TABLE tenants; --"],
    ["partial uuid", "11111111-1111"],
  ])("ChannelFor_%s_isRejected", (_label, candidate) => {
    expect(() => channel_for(candidate)).toThrow(RealtimeAuthorizationError);
  });

  test("ChannelFor_uppercaseUuid_isAccepted", () => {
    expect(() => channel_for(TENANT_A.toUpperCase())).not.toThrow();
  });
});

describe("subscription authorization", () => {
  test("Authorize_authenticatedContext_ownTenant_isPermitted", () => {
    expect(authorize_subscription(authenticated_a, TENANT_A)).toBe(true);
  });

  test("Authorize_authenticatedContext_otherTenant_isDenied", () => {
    expect(authorize_subscription(authenticated_a, TENANT_B)).toBe(false);
  });

  test("Authorize_publicContext_ownTenant_isPermitted", () => {
    expect(authorize_subscription(public_a, TENANT_A)).toBe(true);
  });

  test("Authorize_publicContext_otherTenant_isDenied", () => {
    expect(authorize_subscription(public_a, TENANT_B)).toBe(false);
  });

  /**
   * A platform admin session is not a back door onto a tenant channel. Admins
   * get live data through admin endpoints; allowing an admin context here would
   * create a path a role-confusion bug could ride.
   */
  test("Authorize_platformAdmin_isDeniedEveryTenantChannel", () => {
    expect(authorize_subscription(admin, TENANT_A)).toBe(false);
    expect(authorize_subscription(admin, TENANT_B)).toBe(false);
  });

  test("Authorize_emptyRequestedTenant_isDenied", () => {
    expect(authorize_subscription(authenticated_a, "")).toBe(false);
  });

  /** Comparison is exact: a prefix of a real tenant id must not pass. */
  test("Authorize_prefixOfOwnTenantId_isDenied", () => {
    expect(authorize_subscription(authenticated_a, TENANT_A.slice(0, 20))).toBe(false);
  });

  /**
   * PostgreSQL compares UUIDs case-insensitively, so the same tenant can
   * legitimately arrive in either case. Denying that would break valid
   * subscribers while granting an attacker nothing — case variation only ever
   * matches their own id.
   */
  test("Authorize_caseVariantOfOwnTenantId_isPermitted", () => {
    expect(authorize_subscription(authenticated_a, TENANT_A.toUpperCase())).toBe(true);
  });

  test("Authorize_caseVariantOfAnotherTenantId_isStillDenied", () => {
    expect(authorize_subscription(authenticated_a, TENANT_B.toUpperCase())).toBe(false);
  });
});

describe("assert_can_subscribe", () => {
  test("AssertCanSubscribe_ownTenant_doesNotThrow", () => {
    expect(() => assert_can_subscribe(authenticated_a, TENANT_A)).not.toThrow();
  });

  test("AssertCanSubscribe_crossTenant_throws", () => {
    expect(() => assert_can_subscribe(authenticated_a, TENANT_B)).toThrow(
      RealtimeAuthorizationError,
    );
  });

  test("AssertCanSubscribe_platformAdmin_throws", () => {
    expect(() => assert_can_subscribe(admin, TENANT_A)).toThrow(
      RealtimeAuthorizationError,
    );
  });

  test("AssertCanSubscribe_errorMessage_doesNotLeakTheRequestedTenant", () => {
    try {
      assert_can_subscribe(authenticated_a, TENANT_B);
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(String(error)).not.toContain(TENANT_B);
    }
  });
});
