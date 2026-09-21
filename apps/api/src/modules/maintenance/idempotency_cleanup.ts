/**
 * Expiry of stored idempotency records.
 *
 * PostgreSQL holds the idempotency table deliberately (see
 * `idempotency_service.ts`), which buys transactional exactness at the cost of
 * the TTL a key-value store would have given us. This is that cost, paid
 * explicitly.
 *
 * ## Retention semantics
 *
 * A record is **expired** once `created_at` is older than `retention_hours`
 * (default **48**). Until then it is *active*: a retry carrying its key replays
 * the stored response instead of re-executing. After expiry the key is
 * forgotten, so a retry arriving later is treated as a new request and executes
 * again.
 *
 * 48 hours is the upper end of the 24–48h window in `api-standards.md` §6,
 * chosen so a client retrying after a long outage still gets a replay rather
 * than a duplicate mutation. Shortening it narrows that safety window;
 * lengthening it grows the table. Configurable via
 * `IDEMPOTENCY_RETENTION_HOURS`.
 *
 * ## Safety properties
 *
 * - **Never deletes an active key.** The cutoff is computed once per run and
 *   every statement filters on it, so a key that is unexpired when the run
 *   starts survives it regardless of how long the run takes.
 * - **Safe to run concurrently.** Two overlapping runs may select overlapping
 *   rows, but `DELETE` takes a row lock and re-checks: the second run finds the
 *   row already gone and skips it. No error, no double-delete, no double-count.
 *   A missed schedule that causes two jobs to overlap is harmless.
 *
 *   `FOR UPDATE SKIP LOCKED` would avoid the brief wait, but PostgreSQL
 *   requires the **UPDATE** privilege for it, and the maintenance role is
 *   deliberately granted only `SELECT, DELETE` so a stored response can never
 *   be rewritten. Widening the grant to optimise a background job would be the
 *   wrong trade; a short lock wait on a cleanup batch costs nothing.
 * - **Bounded.** Work is done in batches, each its own transaction, with a cap
 *   on batches per run. A table that has grown large is drained over several
 *   runs rather than in one long-held transaction that would block autovacuum
 *   and inflate replication lag.
 * - **Never reaches tenant data.** The role it runs as is granted
 *   `SELECT, DELETE` on this one table and nothing else.
 */
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../platform/logger.js";

export const DEFAULT_RETENTION_HOURS = 48;
export const DEFAULT_BATCH_SIZE = 1_000;
export const DEFAULT_MAX_BATCHES = 100;

export interface CleanupOptions {
  readonly retention_hours: number;
  readonly batch_size: number;
  /** Cap on batches per run, so one invocation has a bounded worst case. */
  readonly max_batches: number;
}

export const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  retention_hours: DEFAULT_RETENTION_HOURS,
  batch_size: DEFAULT_BATCH_SIZE,
  max_batches: DEFAULT_MAX_BATCHES,
};

export interface CleanupResult {
  readonly deleted: number;
  readonly batches: number;
  readonly cutoff: Date;
  readonly duration_ms: number;
  /**
   * True when the batch cap was reached with rows still expired — the next
   * scheduled run continues. Worth alerting on if it persists, because it means
   * expiry is not keeping up with write volume.
   */
  readonly truncated: boolean;
}

export class CleanupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupConfigError";
  }
}

function assert_valid(options: CleanupOptions): void {
  if (options.retention_hours <= 0) {
    throw new CleanupConfigError(
      "retention_hours must be positive; a zero or negative retention would " +
        "delete keys that are still providing replay protection",
    );
  }
  if (options.batch_size <= 0 || options.batch_size > 50_000) {
    throw new CleanupConfigError("batch_size must be between 1 and 50000");
  }
  if (options.max_batches <= 0) {
    throw new CleanupConfigError("max_batches must be positive");
  }
}

/**
 * Delete expired idempotency records.
 *
 * @param db a client connected as `bullion_maintenance`. Connected as the
 * application role this returns 0 — correctly, since RLS hides every row from a
 * context-less session — which is why the caller must supply the right identity.
 */
export async function purge_expired_keys(
  db: PrismaClient,
  logger: Logger,
  overrides: Partial<CleanupOptions> = {},
): Promise<CleanupResult> {
  const options = { ...DEFAULT_CLEANUP_OPTIONS, ...overrides };
  assert_valid(options);

  const started = Date.now();
  // Computed once. Recomputing per batch would let a long run creep forward and
  // delete keys that were still active when it began.
  const cutoff = new Date(started - options.retention_hours * 3_600_000);

  let deleted = 0;
  let batches = 0;
  let truncated = false;

  logger.info(
    {
      event: "idempotency.cleanup.started",
      cutoff: cutoff.toISOString(),
      retention_hours: options.retention_hours,
      batch_size: options.batch_size,
    },
    "idempotency key cleanup started",
  );

  for (let batch = 0; batch < options.max_batches; batch += 1) {
    // Each batch is its own statement and therefore its own transaction, so a
    // large table is drained incrementally rather than under one long-held
    // transaction that would block autovacuum and inflate replication lag.
    const removed = await db.$executeRaw`
      DELETE FROM idempotency_keys t
      USING (
        SELECT tenant_id, idempotency_key
          FROM idempotency_keys
         WHERE created_at < ${cutoff}
         ORDER BY created_at
         LIMIT ${options.batch_size}
      ) expired
      WHERE t.tenant_id = expired.tenant_id
        AND t.idempotency_key = expired.idempotency_key
    `;

    batches += 1;
    deleted += removed;

    // Exit on an empty batch, not on a short one. Under a concurrent run a
    // batch can come back short because the other run took some of the rows;
    // stopping there would leave expired rows behind and report a clean finish.
    if (removed === 0) break;

    if (batch === options.max_batches - 1) {
      truncated = true;
    }
  }

  const result: CleanupResult = {
    deleted,
    batches,
    cutoff,
    duration_ms: Date.now() - started,
    truncated,
  };

  // Logged at info even when nothing was deleted: "the job ran and found
  // nothing" and "the job never ran" must be distinguishable in the logs, and
  // silence cannot tell them apart.
  logger.info(
    {
      event: "idempotency.cleanup.completed",
      deleted: result.deleted,
      batches: result.batches,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
      cutoff: cutoff.toISOString(),
    },
    `idempotency key cleanup removed ${result.deleted} row(s)`,
  );

  if (result.truncated) {
    logger.warn(
      {
        event: "idempotency.cleanup.truncated",
        deleted: result.deleted,
        max_batches: options.max_batches,
      },
      "idempotency cleanup hit its batch cap; expired rows remain for the next run",
    );
  }

  return result;
}

/** Rows currently eligible for deletion. For monitoring, not for the request path. */
export async function count_expired_keys(
  db: PrismaClient,
  retention_hours = DEFAULT_RETENTION_HOURS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retention_hours * 3_600_000);
  return db.idempotency_keys.count({ where: { created_at: { lt: cutoff } } });
}
