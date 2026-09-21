import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Component tests run in jsdom against the real components.
 *
 * There is no browser-automation stack here on purpose. The behaviours that
 * matter on these pages — rendering a rate, degrading when it is stale,
 * reporting a concurrency conflict, surviving a malformed realtime frame — are
 * all reachable with Testing Library, and the cross-tenant guarantee is proven
 * where it is actually enforced, against real RLS in the API's integration
 * suite. Adding Playwright would be a large dependency for a thinner assertion.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@bullion/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/lib/**/*.ts", "src/components/**/*.tsx"],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },
});
