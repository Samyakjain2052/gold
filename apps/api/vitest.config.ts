import { defineConfig } from "vitest/config";

/**
 * Unit tests: pure logic, no containers, no network.
 *
 * Coverage thresholds here apply to code whose behaviour is fully determined
 * without a database. Modules whose correctness *is* their database behaviour
 * (tenant context, RLS-scoped services, public projections, Redis fan-out) are
 * excluded below and measured by the integration run instead — a unit-mocked
 * test of those would assert that a mock was called, not that isolation holds.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/generated/**",
        // Thin adapters over pino / node-redis / Prisma with no branching of
        // our own; exercised by the integration suite.
        "src/platform/logger.ts",
        "src/platform/redis.ts",
        "src/platform/db.ts",
        // Database-bound. Covered by tests/integration, which runs as a
        // required CI gate (`npm run test:isolation`). The pure half of the
        // realtime layer (channel naming, subscription authorisation) is NOT
        // excluded — it needs no broker and is measured here.
        "src/modules/tenancy/**",
        "src/modules/public/**",
        "src/modules/pricing/pricing_rule_service.ts",
        // Stage 7. Routes and the transactional halves of audit/idempotency
        // are only meaningful against a real database; their PURE parts
        // (snapshot allowlist, diffing, fingerprinting, request schemas) are
        // NOT excluded and are measured here.
        "src/http/routes/pricing_rules.ts",
        "src/http/routes/audit_logs.ts",
      ],
      // testing-best-practices.md §17. Pricing and money are critical paths and
      // are held to 90%.
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
        "src/modules/pricing/**": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
        "src/modules/market_data/**": {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90,
        },
        "src/platform/money.ts": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
