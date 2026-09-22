import { defineConfig } from "vitest/config";

/**
 * Integration tests run against a real PostgreSQL and Redis.
 *
 * File parallelism is off: every suite truncates and reseeds the same fixture
 * tenants, so running files concurrently would have them clobber each other's
 * data. Sequential execution keeps each suite's fixtures deterministic, which
 * `testing-best-practices.md` §8 requires and which isolation tests especially
 * need — a flaky isolation suite is worse than none.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage-integration",
      // Exactly the modules the unit run excludes — the ones whose behaviour
      // IS their database behaviour. Realtime authorisation is pure and is
      // measured by the unit suite instead; only its delivery path needs Redis.
      include: [
        "src/modules/tenancy/**/*.ts",
        "src/modules/public/**/*.ts",
        "src/modules/pricing/pricing_rule_service.ts",
        "src/modules/audit/**/*.ts",
        "src/modules/idempotency/**/*.ts",
        "src/http/routes/pricing_rules.ts",
        "src/http/routes/audit_logs.ts",
        "src/http/routes/public.ts",
        "src/http/routes/me.ts",
      ],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
      },
    },
  },
});
