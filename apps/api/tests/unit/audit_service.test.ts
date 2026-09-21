/**
 * The pure half of the audit module: what gets recorded, and what must not.
 *
 * Writing and reading rows needs a database and lives in the integration suite.
 * Snapshot projection, diffing and actor derivation are pure — and they are
 * where a leak would originate, so they are tested directly.
 */
import { describe, expect, test } from "vitest";
import {
  actor_from_context,
  changed_fields,
  to_audit_snapshot,
  to_audit_view,
} from "../../src/modules/audit/audit_service.js";
import type {
  AuthenticatedTenantContext,
  PlatformAdminContext,
} from "../../src/modules/tenancy/tenant_context.js";

const TENANT = "a1b2c3d4-1111-4111-8111-1111111111ff";
const USER = "33333333-3333-4333-8333-333333333333";

describe("to_audit_snapshot", () => {
  test("Snapshot_includesTheAuditableFields", () => {
    const snapshot = to_audit_snapshot({
      product_id: "p1",
      adjustment_kind: "absolute",
      adjustment_value: 5_000_000n,
      adjustment_bps: 0,
      rounding_step_paise: 100,
      rounding_mode: "half_up",
      component_precision_paise: 1,
      is_active: true,
      version: 3,
    });

    expect(Object.keys(snapshot).sort()).toEqual([
      "adjustment_bps",
      "adjustment_kind",
      "adjustment_value",
      "component_precision_paise",
      "is_active",
      "product_id",
      "rounding_mode",
      "rounding_step_paise",
      "version",
    ]);
  });

  /**
   * The allowlist is the control. A column added to the table later — or a row
   * that happens to carry something sensitive — must not reach a durable,
   * widely-readable audit row unless someone adds it deliberately.
   */
  test("Snapshot_excludesAnythingNotOnTheAllowlist", () => {
    const snapshot = to_audit_snapshot({
      adjustment_value: 1n,
      tenant_id: TENANT,
      created_by: USER,
      updated_by: USER,
      id: "rule-1",
      created_at: new Date(),
      // The kind of field that must never be captured by accident.
      api_key: "super-secret",
      password_hash: "argon2id$...",
    });

    expect(snapshot).not.toHaveProperty("tenant_id");
    expect(snapshot).not.toHaveProperty("created_by");
    expect(snapshot).not.toHaveProperty("api_key");
    expect(snapshot).not.toHaveProperty("password_hash");
    expect(JSON.stringify(snapshot)).not.toContain("super-secret");
  });

  /**
   * `bigint` has no JSON form. Stringified rather than `Number()`-ed, because
   * `Number` would silently lose precision on exactly the monetary values this
   * system exists to keep exact.
   */
  test("Snapshot_bigintBecomesAStringNotANumber", () => {
    const snapshot = to_audit_snapshot({ adjustment_value: 9_007_199_254_740_993n });

    expect(snapshot["adjustment_value"]).toBe("9007199254740993");
    expect(typeof snapshot["adjustment_value"]).toBe("string");
  });

  test("Snapshot_absentFields_areOmittedNotNulled", () => {
    const snapshot = to_audit_snapshot({ adjustment_value: 1n });
    expect(snapshot).not.toHaveProperty("rounding_mode");
  });

  test("Snapshot_isJsonSerialisable", () => {
    const snapshot = to_audit_snapshot({ adjustment_value: 5_000_000n, version: 2 });
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
});

describe("changed_fields", () => {
  test("ChangedFields_reportsOnlyWhatMoved", () => {
    const before = { adjustment_value: "5000000", version: 1, rounding_mode: "half_up" };
    const after = { adjustment_value: "8000000", version: 2, rounding_mode: "half_up" };

    expect(changed_fields(before, after)).toEqual(["adjustment_value", "version"]);
  });

  test("ChangedFields_identicalSnapshots_reportNothing", () => {
    const snapshot = { adjustment_value: "1", version: 1 };
    expect(changed_fields(snapshot, { ...snapshot })).toEqual([]);
  });

  test("ChangedFields_addedOrRemovedKeys_countAsChanged", () => {
    expect(changed_fields({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(changed_fields({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
  });

  /** A creation or deletion has nothing to diff against. */
  test("ChangedFields_withANullSide_isEmpty", () => {
    expect(changed_fields(null, { a: 1 })).toEqual([]);
    expect(changed_fields({ a: 1 }, null)).toEqual([]);
  });

  test("ChangedFields_areSortedForStableReading", () => {
    const changed = changed_fields({ z: 1, a: 1 }, { z: 2, a: 2 });
    expect(changed).toEqual(["a", "z"]);
  });
});

describe("actor_from_context", () => {
  const shopkeeper: AuthenticatedTenantContext = {
    kind: "authenticated",
    tenant_id: TENANT,
    user_id: USER,
    role: "manager",
  };

  const admin: PlatformAdminContext = { kind: "platform_admin", user_id: USER };

  test("Actor_authenticatedContext_recordsRoleAtTimeOfAction", () => {
    expect(actor_from_context(shopkeeper)).toEqual({
      user_id: USER,
      actor_type: "authenticated",
      actor_role: "manager",
    });
  });

  test("Actor_platformAdmin_isDistinguishedAndCarriesNoTenantRole", () => {
    const actor = actor_from_context(admin);
    expect(actor.actor_type).toBe("platform_admin");
    // A platform admin holds no tenant role — recording one would imply an
    // authority they do not have.
    expect(actor.actor_role).toBeNull();
  });

  /** The actor always comes from a derived context, never from a request. */
  test("Actor_isDerivedFromContextAlone", () => {
    expect(actor_from_context.length).toBe(1);
  });
});

describe("to_audit_view", () => {
  const row = {
    id: 42n,
    action: "pricing_rule.updated",
    entity_type: "tenant_pricing_rules",
    entity_id: "rule-1",
    actor_type: "authenticated",
    actor_role: "owner",
    old_value: { adjustment_value: "5000000" },
    new_value: { adjustment_value: "8000000", __changed: ["adjustment_value"] },
    request_id: "req-1",
    created_at: new Date("2026-09-20T12:00:00.000Z"),
  };

  test("View_liftsChangedFieldsOutOfTheStoredPayload", () => {
    const view = to_audit_view(row);

    expect(view.changed_fields).toEqual(["adjustment_value"]);
    // The internal marker does not leak into the rendered value.
    expect(view.new_value).not.toHaveProperty("__changed");
    expect(view.new_value).toEqual({ adjustment_value: "8000000" });
  });

  test("View_bigintIdBecomesAString", () => {
    expect(to_audit_view(row).id).toBe("42");
  });

  test("View_timestampIsIso", () => {
    expect(to_audit_view(row).created_at).toBe("2026-09-20T12:00:00.000Z");
  });

  /**
   * Actor personal data is retained in the table for incident response but is
   * not part of the view — ordinary dashboard users have no need to browse it.
   */
  test("View_withholdsActorPersonalData", () => {
    const view = to_audit_view(row) as unknown as Record<string, unknown>;

    expect(view).not.toHaveProperty("actor_user_id");
    expect(view).not.toHaveProperty("ip_address");
    expect(view).not.toHaveProperty("user_agent");
  });

  test("View_nullValues_surviveAsNull", () => {
    const view = to_audit_view({ ...row, old_value: null, new_value: null });
    expect(view.old_value).toBeNull();
    expect(view.new_value).toBeNull();
    expect(view.changed_fields).toEqual([]);
  });
});
