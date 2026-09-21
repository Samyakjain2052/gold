/**
 * Idempotency-key cleanup, as a one-off process.
 *
 * `backend-standards.md` §1: "Admin tasks (migrations, scripts) run as one-off
 * processes with same codebase and config." This is one — the same image, the
 * same configuration, a different entry point. No second worker architecture,
 * no new infrastructure dependency, no in-process timer competing with request
 * handling.
 *
 * Production schedules it as an **Azure Container Apps Job** on a cron trigger,
 * which `api-standards.md` §11 nominates for exactly this shape of work:
 * "peripheral tasks … cleanup jobs as serverless". The command is in
 * `infra/README.md`; nothing is provisioned yet.
 *
 *     npm run maintenance:purge-idempotency --workspace apps/api
 *
 * Exit codes: 0 success, 1 failure, 78 (EX_CONFIG) misconfiguration. A
 * scheduler treats a non-zero exit as a failed run, which is the signal that
 * cleanup has stopped happening.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import {
  count_expired_keys,
  purge_expired_keys,
  CleanupConfigError,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_BATCHES,
  DEFAULT_RETENTION_HOURS,
} from "../src/modules/maintenance/idempotency_cleanup.js";

async function load_local_env(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: path.resolve(here, "../../../.env"), quiet: true });
}

function positive_int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CleanupConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  await load_local_env();

  const logger = pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    base: { service: "bullion-maintenance", job: "purge-idempotency-keys" },
  });

  /**
   * Deliberately its own variable, with no fallback to `DATABASE_URL` or
   * `DATABASE_MIGRATION_URL`.
   *
   * Falling back to the application role would delete nothing — RLS hides every
   * row from a context-less session — and the job would report success while
   * the table grew. Falling back to the admin role would work locally, where
   * Docker makes it a superuser, and silently stop working on Azure, where the
   * administrator is not one. Both failures are silent, so neither fallback is
   * offered.
   */
  const url = process.env["DATABASE_MAINTENANCE_URL"];
  if (url === undefined || url.trim() === "") {
    logger.error(
      { event: "idempotency.cleanup.misconfigured" },
      "DATABASE_MAINTENANCE_URL is required: cleanup must connect as the " +
        "bullion_maintenance role, which holds BYPASSRLS and access to the " +
        "idempotency_keys table alone",
    );
    process.exit(78); // EX_CONFIG
  }

  const options = {
    retention_hours: positive_int("IDEMPOTENCY_RETENTION_HOURS", DEFAULT_RETENTION_HOURS),
    batch_size: positive_int("IDEMPOTENCY_CLEANUP_BATCH_SIZE", DEFAULT_BATCH_SIZE),
    max_batches: positive_int("IDEMPOTENCY_CLEANUP_MAX_BATCHES", DEFAULT_MAX_BATCHES),
  };

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    const before = await count_expired_keys(db, options.retention_hours);
    const result = await purge_expired_keys(db, logger, options);

    // Reported so a run that deleted nothing is still visibly a run.
    logger.info(
      {
        event: "idempotency.cleanup.summary",
        expired_before: before,
        deleted: result.deleted,
        remaining: Math.max(0, before - result.deleted),
      },
      "idempotency cleanup finished",
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`idempotency cleanup failed: ${message}\n`);
  process.exit(error instanceof CleanupConfigError ? 78 : 1);
});
