/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Migrate reads the connection URL from here rather than from schema.prisma.
 * The runtime client gets its connection through a driver adapter — see
 * src/platform/db.ts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// The .env lives at the repo root, but the CLI runs from apps/api.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env"), quiet: true });

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    // Dev-only seed. The script itself refuses to run against production.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations need DDL rights, which the runtime role deliberately lacks.
    // Falls back to DATABASE_URL for environments with a single role.
    url: process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"] ?? "",
  },
});
