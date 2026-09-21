/**
 * Tenant isolation at the DATABASE layer.
 *
 * These tests bypass the application entirely and speak raw SQL as the
 * application role. They prove the backstop holds even if every line of service
 * code were wrong — which is the only reason a backstop is worth having.
 *
 * Precondition asserted by the first test: the connection is neither a
 * superuser nor the table owner. PostgreSQL exempts superusers from RLS and
 * lets owners bypass their own policies, so without that check the whole file
 * could pass while enforcing nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  app_client,
  owner_client,
  query_as_app,
  seed_fixtures,
  TENANT_OWNED_TABLES,
  type Fixtures,
} from "./fixtures.js";

let owner: PrismaClient;
let app: PrismaClient;
let fx: Fixtures;

beforeAll(async () => {
  owner = owner_client();
  app = app_client();
  fx = await seed_fixtures(owner);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
});

describe("RLS preconditions", () => {
  /** If this fails, every other test in this file is meaningless. */
  test("RLS_applicationRole_isNotSuperuserAndNotBypassRls", async () => {
    const rows = await query_as_app<{ rolsuper: boolean; rolbypassrls: boolean }>(
      app,
      null,
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );

    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  test("RLS_applicationRole_isNotTheTableOwner", async () => {
    const rows = await query_as_app<{ is_owner: boolean }>(
      app,
      null,
      `SELECT bool_or(tableowner = current_user) AS is_owner
         FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rows[0]?.is_owner).toBe(false);
  });

  /** A new tenant-owned table must not be able to ship unprotected. */
  test("RLS_everyTableWithTenantId_hasRlsEnabledAndForced", async () => {
    const rows = await query_as_app<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      app,
      null,
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_name = c.relname
                         AND col.column_name = 'tenant_id')`,
    );

    expect(rows.length).toBeGreaterThanOrEqual(TENANT_OWNED_TABLES.length);
    for (const row of rows) {
      expect(row.rls_enabled, `${row.table_name} RLS enabled`).toBe(true);
      expect(row.rls_forced, `${row.table_name} RLS forced`).toBe(true);
    }
  });

  test("RLS_tenantOwnedTableList_matchesTheDatabase", async () => {
    const rows = await query_as_app<{ table_name: string }>(
      app,
      null,
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );
    const actual = rows.map((r) => r.table_name).sort();
    expect(actual).toEqual([...TENANT_OWNED_TABLES].sort());
  });
});

describe("RLS SELECT", () => {
  test("RLS_noTenantContext_returnsZeroRowsFromEveryTenantTable", async () => {
    for (const table of TENANT_OWNED_TABLES) {
      const rows = await query_as_app(app, null, `SELECT * FROM ${table}`);
      expect(rows, `${table} with no context`).toHaveLength(0);
    }
  });

  test("RLS_tenantAContext_returnsOnlyTenantARows", async () => {
    for (const table of TENANT_OWNED_TABLES) {
      const rows = await query_as_app<{ tenant_id: string }>(
        app,
        fx.tenant_a.tenant_id,
        `SELECT tenant_id FROM ${table}`,
      );
      expect(rows.length, `${table} should have tenant A rows`).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.tenant_id === fx.tenant_a.tenant_id),
        `${table} leaked a foreign tenant_id`,
      ).toBe(true);
    }
  });

  test("RLS_tenantAContext_cannotSelectTenantBByPrimaryKey", async () => {
    const rows = await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `SELECT * FROM tenant_pricing_rules WHERE id = '${fx.tenant_b.gold_rule_id}'`,
    );
    expect(rows).toHaveLength(0);
  });

  test("RLS_tenantAContext_cannotSelectTenantBTenantRow", async () => {
    const rows = await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `SELECT * FROM tenants WHERE id = '${fx.tenant_b.tenant_id}'`,
    );
    expect(rows).toHaveLength(0);
  });

  /** Fail closed: an unparseable context must not fall back to "see all". */
  test("RLS_invalidTenantContext_returnsZeroRowsOrErrors", async () => {
    for (const bogus of ["not-a-uuid", "", "00000000-0000-0000-0000-000000000000"]) {
      let rows: unknown[] = [];
      try {
        rows = await query_as_app(app, bogus, "SELECT * FROM tenant_pricing_rules");
      } catch {
        continue; // A cast failure is an acceptable fail-closed outcome.
      }
      expect(rows, `context "${bogus}"`).toHaveLength(0);
    }
  });

  test("RLS_contextDoesNotLeakBetweenTransactionsOnAPooledConnection", async () => {
    const with_a = await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      "SELECT tenant_id FROM tenant_pricing_rules",
    );
    expect(with_a.length).toBeGreaterThan(0);

    // Same pooled client, new transaction, no context set.
    const without = await query_as_app(app, null, "SELECT * FROM tenant_pricing_rules");
    expect(without).toHaveLength(0);
  });
});

describe("RLS INSERT", () => {
  test("RLS_tenantAContext_cannotInsertRowForTenantB", async () => {
    await expect(
      query_as_app(
        app,
        fx.tenant_a.tenant_id,
        `INSERT INTO tenant_pricing_rules
           (id, tenant_id, product_id, adjustment_kind, adjustment_value,
            adjustment_bps, rounding_step_paise, rounding_mode, is_active,
            component_precision_paise, created_at, updated_at)
         VALUES (gen_random_uuid(), '${fx.tenant_b.tenant_id}',
                 '${fx.tenant_b.gold_product_id}', 'absolute', 999, 0, 100,
                 'half_up', false, 1, now(), now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test("RLS_noTenantContext_cannotInsertAtAll", async () => {
    await expect(
      query_as_app(
        app,
        null,
        `INSERT INTO audit_logs (tenant_id, action, created_at)
         VALUES ('${fx.tenant_a.tenant_id}', 'forged', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test("RLS_tenantAContext_canInsertItsOwnRow", async () => {
    const id = randomUUID();
    await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `INSERT INTO audit_logs (tenant_id, action, entity_id, created_at)
       VALUES ('${fx.tenant_a.tenant_id}', 'test.insert', '${id}', now())`,
    );

    const rows = await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `SELECT * FROM audit_logs WHERE entity_id = '${id}'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("RLS UPDATE", () => {
  test("RLS_tenantAContext_cannotUpdateTenantBRow", async () => {
    await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `UPDATE tenant_pricing_rules SET adjustment_value = 1
        WHERE id = '${fx.tenant_b.gold_rule_id}'`,
    );

    // Verified independently as owner: B's value is untouched.
    const rule = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_b.gold_rule_id },
      select: { adjustment_value: true },
    });
    expect(rule?.adjustment_value).toBe(10_000_000n);
  });

  test("RLS_tenantAContext_cannotReassignItsOwnRowToTenantB", async () => {
    await expect(
      query_as_app(
        app,
        fx.tenant_a.tenant_id,
        `UPDATE tenant_pricing_rules SET tenant_id = '${fx.tenant_b.tenant_id}'
          WHERE id = '${fx.tenant_a.gold_rule_id}'`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test("RLS_noTenantContext_updatesAffectZeroRows", async () => {
    await query_as_app(
      app,
      null,
      "UPDATE tenant_pricing_rules SET adjustment_value = 7",
    );

    const untouched = await owner.tenant_pricing_rules.count({
      where: { adjustment_value: 7n },
    });
    expect(untouched).toBe(0);
  });

  test("RLS_tenantAContext_canUpdateItsOwnRow", async () => {
    await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `UPDATE tenant_pricing_rules SET adjustment_value = 5000001
        WHERE id = '${fx.tenant_a.gold_rule_id}'`,
    );

    const rule = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_a.gold_rule_id },
      select: { adjustment_value: true },
    });
    expect(rule?.adjustment_value).toBe(5_000_001n);

    await owner.tenant_pricing_rules.update({
      where: { id: fx.tenant_a.gold_rule_id },
      data: { adjustment_value: 5_000_000n },
    });
  });
});

describe("RLS DELETE", () => {
  test("RLS_tenantAContext_cannotDeleteTenantBRow", async () => {
    await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `DELETE FROM tenant_pricing_rules WHERE id = '${fx.tenant_b.gold_rule_id}'`,
    );

    const still_there = await owner.tenant_pricing_rules.count({
      where: { id: fx.tenant_b.gold_rule_id },
    });
    expect(still_there).toBe(1);
  });

  test("RLS_noTenantContext_deletesAffectZeroRows", async () => {
    const before = await owner.tenant_pricing_rules.count();
    await query_as_app(app, null, "DELETE FROM tenant_pricing_rules");
    expect(await owner.tenant_pricing_rules.count()).toBe(before);
  });

  test("RLS_tenantAContext_canDeleteItsOwnRow", async () => {
    const created = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      return tx.tenant_pricing_rules.create({
        data: {
          tenant_id: fx.tenant_a.tenant_id,
          product_id: fx.tenant_a.silver_product_id,
          adjustment_kind: "absolute",
          adjustment_value: 1n,
          rounding_step_paise: 100,
        },
        select: { id: true },
      });
    });

    await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `DELETE FROM tenant_pricing_rules WHERE id = '${created.id}'`,
    );

    expect(
      await owner.tenant_pricing_rules.count({ where: { id: created.id } }),
    ).toBe(0);
  });
});

describe("RLS public customer context", () => {
  /**
   * The public page runs under the same RLS mechanism with the tenant resolved
   * from a slug. It is subject to identical filtering — the public path gets no
   * weaker policy.
   */
  test("RLS_publicContextForTenantA_seesOnlyTenantARows", async () => {
    const rows = await query_as_app<{ tenant_id: string }>(
      app,
      fx.tenant_a.tenant_id,
      "SELECT tenant_id FROM published_rates",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === fx.tenant_a.tenant_id)).toBe(true);
  });

  test("RLS_publicContextForTenantA_cannotReadTenantBPublishedRates", async () => {
    const rows = await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `SELECT * FROM published_rates WHERE tenant_id = '${fx.tenant_b.tenant_id}'`,
    );
    expect(rows).toHaveLength(0);
  });

  test("RLS_publicContext_cannotReadAuditLogsOfAnotherTenant", async () => {
    const rows = await query_as_app(
      app,
      fx.tenant_a.tenant_id,
      `SELECT * FROM audit_logs WHERE tenant_id = '${fx.tenant_b.tenant_id}'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("RLS audit immutability", () => {
  test("RLS_auditLogs_cannotBeUpdatedByApplicationRole", async () => {
    await expect(
      query_as_app(
        app,
        fx.tenant_a.tenant_id,
        "UPDATE audit_logs SET action = 'tampered'",
      ),
    ).rejects.toThrow();
  });

  test("RLS_auditLogs_cannotBeDeletedByApplicationRole", async () => {
    await expect(
      query_as_app(app, fx.tenant_a.tenant_id, "DELETE FROM audit_logs"),
    ).rejects.toThrow();
  });
});
