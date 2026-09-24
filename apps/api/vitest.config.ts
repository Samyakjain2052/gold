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
        // Stage 8. Both are thin transports over services that are themselves
        // measured: the public routes resolve a slug and project through
        // `public_service`, and `/me` is a single context-scoped read. They are
        // only meaningful against real RLS, so they are covered by
        // tests/integration/public_api.test.ts instead.
        //
        // `src/modules/realtime/**` stays INCLUDED: the hub's fan-out,
        // authorisation and teardown are pure and are measured by
        // tests/unit/rate_hub.test.ts.
        "src/http/routes/public.ts",
        "src/http/routes/me.ts",
        // Stage 10. The pipeline is only meaningful against a real provider
        // loop, real Redis and real PostgreSQL: leadership is a property of
        // concurrent processes, and publication is a property of a committed
        // transaction. All four are covered by tests/integration —
        // vertical_slice.test.ts and leader_election.test.ts.
        //
        // The pure parts are NOT excluded and are measured here:
        // `pipeline_health.ts` (readiness decisions) has its own unit suite,
        // and the pricing engine it calls is held to 90%.
        "src/platform/leader_lock.ts",
        "src/modules/market_data/market_poller.ts",
        "src/modules/publication/publication_service.ts",
        "src/modules/publication/outbox_publisher.ts",
        "src/modules/publication/pipeline.ts",
        // Onboarding writes seven rows across six RLS-protected tables in one
        // transaction, and its whole point is that the policies accept them.
        // That is only demonstrable against a real database — covered by
        // tests/integration/onboarding.test.ts, including the pure slug rules.
        "src/modules/onboarding/**",
        "src/http/routes/onboarding.ts",
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
