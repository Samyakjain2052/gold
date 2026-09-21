/**
 * Transactional idempotency.
 *
 * ## Why this is not in Redis
 *
 * `api-standards.md` §6 specifies Redis-backed idempotency keys, and for most
 * endpoints that is right. It cannot hold here.
 *
 * Stage 7 requires that a pricing mutation, its audit row, and the record that
 * the request was already handled all commit together. A Redis key cannot join
 * a PostgreSQL transaction, so this sequence is possible:
 *
 *   1. transaction commits — rule updated, audit row written
 *   2. process dies before the Redis key is stored
 *   3. client retries
 *   4. mutation runs a second time; a **second audit row** is written
 *
 * That is exactly the duplicate-audit outcome the brief forbids. Storing the
 * key in the same database, in the same transaction, makes step 2 impossible:
 * either everything committed or nothing did.
 *
 * Redis remains the store for rate limiting, where approximate state costs
 * nothing.
 *
 * **Trade-off accepted:** no TTL. Rows are expired by a sweep
 * (`purge_expired_keys`) rather than by the store. `idx_idempotency_keys_created_at`
 * supports it.
 *
 * ## Semantics
 *
 * | Case | Result |
 * |---|---|
 * | Key unseen | Execute; store status + body in the same transaction |
 * | Key seen, same fingerprint | Replay the stored response; execute nothing |
 * | Key seen, different fingerprint | `409` — same key, different request is a client bug |
 * | Key in flight concurrently | `409` — the second caller loses the race on the primary key |
 *
 * The fingerprint check matters: without it, a client that reuses a key for a
 * genuinely different change would silently receive the earlier response and
 * believe a change was applied that never was.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../platform/errors.js";
import {
  violates_constraint,
  CONSTRAINTS,
} from "../../platform/prisma_errors.js";

/** Minimum key length. Short keys collide by accident. */
export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Fingerprint a request.
 *
 * Body keys are sorted so that a semantically identical retry with differently
 * ordered JSON is recognised as the same request rather than treated as a
 * conflicting one.
 */
export function fingerprint_request(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()}\n${path}\n${canonical_json(body)}`)
    .digest("hex");
}

function canonical_json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical_json).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical_json(v)}`);

  return `{${entries.join(",")}}`;
}

export function assert_valid_key(key: string): void {
  if (
    key.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw AppError.validation(
      `Idempotency-Key must be ${MIN_IDEMPOTENCY_KEY_LENGTH}-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (!/^[\w.:-]+$/.test(key)) {
    throw AppError.validation(
      "Idempotency-Key may contain only letters, digits, and . : _ -",
    );
  }
}

/**
 * Look for a previously stored response.
 *
 * Runs on the caller's transaction so the lookup sees the same snapshot the
 * mutation will write into.
 */
export async function find_stored_response(
  tx: Prisma.TransactionClient,
  tenant_id: string,
  key: string,
  fingerprint: string,
): Promise<StoredResponse | null> {
  const existing = await tx.idempotency_keys.findFirst({
    where: { tenant_id, idempotency_key: key },
    select: { request_fingerprint: true, response_status: true, response_body: true },
  });

  if (existing === null) return null;

  if (existing.request_fingerprint !== fingerprint) {
    // Same key, different request. Replaying the old response would tell the
    // caller their new change succeeded when it was never applied.
    throw new AppError(
      "CONFLICT",
      "This Idempotency-Key was already used for a different request",
    );
  }

  return { status: existing.response_status, body: existing.response_body };
}

/**
 * Record the outcome, in the caller's transaction.
 *
 * A unique-violation here means a concurrent request with the same key won the
 * race. That is a genuine conflict, not a retry, so it surfaces as `409`
 * rather than a `500`.
 */
export async function store_response(
  tx: Prisma.TransactionClient,
  tenant_id: string,
  key: string,
  fingerprint: string,
  response: StoredResponse,
): Promise<void> {
  try {
    await tx.idempotency_keys.create({
      data: {
        tenant_id,
        idempotency_key: key,
        request_fingerprint: fingerprint,
        response_status: response.status,
        response_body: response.body as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    // Only OUR primary key. A unique violation from any other constraint is a
    // different problem, and reporting it as "already in progress" would send
    // the caller chasing a retry that cannot help.
    if (violates_constraint(error, CONSTRAINTS.idempotency_key)) {
      throw new AppError(
        "CONFLICT",
        "A request with this Idempotency-Key is already in progress",
      );
    }
    throw error;
  }
}

/**
 * Delete keys older than `retention_hours`.
 *
 * `api-standards.md` §6 suggests a 24–48h window; 48 is used so a client
 * retrying after a long outage still gets replay rather than re-execution.
 * Intended for a scheduled job, not a request path.
 */
export async function purge_expired_keys(
  db: PrismaClient,
  retention_hours = 48,
): Promise<number> {
  const cutoff = new Date(Date.now() - retention_hours * 3_600_000);
  const result = await db.idempotency_keys.deleteMany({
    where: { created_at: { lt: cutoff } },
  });
  return result.count;
}
