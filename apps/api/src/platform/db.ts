/**
 * Database access.
 *
 * Tenant isolation layer 3 lives here: every tenant-scoped query runs inside a
 * transaction that first sets `app.current_tenant_id`, which the RLS policies
 * filter on. See docs/database-schema.md.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import type { AppConfig } from "./config.js";

export type Database = PrismaClient;

export function create_database(config: AppConfig): PrismaClient {
  // Prisma 7 driver adapter. The pool must stay modest: RLS binds the tenant
  // context to a transaction, so connections are held only for a request.
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
  });

  return new PrismaClient({ adapter, log: ["warn", "error"] });
}

/** Trivial round-trip used by the readiness probe. */
export async function ping_database(db: PrismaClient): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}

/**
 * Run `work` with a tenant's RLS context bound to the transaction.
 *
 * `set_config(..., TRUE)` scopes the setting to the transaction, so a pooled
 * connection cannot carry one tenant's context into the next request — the
 * failure mode that would otherwise make RLS worse than useless.
 *
 * Nothing here trusts a caller-supplied tenant id: callers receive `tenant_id`
 * from the authenticated context or from a resolved public slug, never from a
 * request body.
 */
export async function with_tenant_context<T>(
  db: PrismaClient,
  tenant_id: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenant_id)) {
    throw new Error("with_tenant_context requires a UUID tenant id");
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant_id}, TRUE)`;
    return work(tx);
  });
}
