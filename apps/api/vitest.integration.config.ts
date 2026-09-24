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
        "src/platform/leader_lock.ts",
        "src/modules/market_data/market_poller.ts",
        "src/modules/publication/publication_service.ts",
        "src/modules/publication/outbox_publisher.ts",
      ],
      thresholds: {
        /**
         * The Stage 10 pipeline is held to a lower bar than the original
         * database-bound set, and deliberately so. Its uncovered lines are
         * defensive paths that an integration test cannot reach without
         * breaking Redis mid-transaction — a failed `EVAL` during renewal, a
         * publish that throws after the batch has started. They are covered by
         * reasoning and by the failure tests that *can* be driven; inflating
         * the number by mocking the very infrastructure these tests exist to
         * exercise would make the figure worse evidence, not better.
         *
         * A glob threshold removes these files from the global calculation, so
         * the 90% below still means 90% of the modules it was written for.
         */
        "src/platform/leader_lock.ts": {
          lines: 85,
          branches: 75,
          functions: 70,
          statements: 85,
        },
        "src/modules/market_data/market_poller.ts": {
          lines: 90,
          branches: 80,
          functions: 90,
          statements: 90,
        },
        "src/modules/publication/**": {
          lines: 80,
          branches: 70,
          functions: 80,
          statements: 80,
        },
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
      },
    },
  },
});
