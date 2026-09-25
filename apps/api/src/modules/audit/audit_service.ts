/**
 * The audit trail.
 *
 * ## The invariant
 *
 * **An audit row exists if and only if the mutation it describes committed.**
 *
 * `write_audit` takes a transaction client, never a `PrismaClient`. It cannot
 * be called outside a transaction, so it cannot record something that later
 * rolls back, and a mutation cannot commit while its audit row is lost. The two
 * outcomes the brief forbids — mutation without audit, audit without mutation —
 * are both unreachable rather than merely unlikely.
 *
 * ## Why failures are not audited here
 *
 * A rejected mutation leaves no audit row. That is deliberate: it keeps the
 * table's meaning exact — *everything in it happened*. A table mixing attempts
 * with facts forces every reader to filter, and a reader who forgets draws the
 * wrong conclusion.
 *
 * Failed attempts and permission violations are still recorded, as structured
 * log events (`backend-standards.md` §5). They are security telemetry, not
 * history of state.
 *
 * ## Append-only
 *
 * Enforced twice in the database, not by convention:
 *   - `REVOKE UPDATE, DELETE ON audit_logs FROM bullion_app`
 *   - a `BEFORE UPDATE OR DELETE` trigger that raises
 *
 * So no application code path — including a bug in this module — can rewrite
 * history. RLS restricts each tenant to its own rows.
 */
import { Prisma } from "@prisma/client";
import type {
  AuthenticatedTenantContext,
  PlatformAdminContext,
} from "../tenancy/tenant_context.js";

/** How the actor was acting. Recorded because authority differs by kind. */
export type ActorType = "authenticated" | "platform_admin" | "system";

/**
 * Audited actions. A closed set rather than free text, so the table stays
 * queryable and a typo cannot silently create a new "action".
 */
export type AuditAction =
  | "pricing_rule.created"
  | "pricing_rule.updated"
  | "pricing_rule.deactivated"
  | "tenant_settings.updated"
  | "tenant_product.updated";

export interface AuditActor {
  readonly user_id: string | null;
  readonly actor_type: ActorType;
  /** Tenant role held AT THE TIME of the action, not today's role. */
  readonly actor_role: string | null;
}

/** Request metadata for correlation. Deliberately narrow — see `redact`. */
export interface AuditRequestContext {
  readonly request_id: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
}

export interface AuditEntry {
  readonly tenant_id: string;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly entity_type: string;
  readonly entity_id: string;
  /** State before the change. `null` for a creation. */
  readonly old_value: Record<string, unknown> | null;
  /** State after the change. `null` for a deletion. */
  readonly new_value: Record<string, unknown> | null;
  readonly request: AuditRequestContext;
}

/**
 * Fields permitted in an audited before/after snapshot.
 *
 * An allowlist, not a denylist: a column added to `tenant_pricing_rules` later
 * cannot reach the audit log unless someone adds it here deliberately. That
 * matters because audit rows are long-lived and widely readable within a
 * tenant — a secret written here would be durable and hard to retract.
 */
const AUDITABLE_PRICING_FIELDS = [
  "product_id",
  "adjustment_kind",
  "adjustment_value",
  "adjustment_bps",
  "rounding_step_paise",
  "rounding_mode",
  "component_precision_paise",
  "is_active",
  "version",
] as const;

/**
 * Project a row into an auditable snapshot.
 *
 * `bigint` is stringified because JSON cannot represent it — and because the
 * alternative, `Number()`, would silently lose precision on exactly the
 * monetary values this system exists to keep exact.
 */
export function to_audit_snapshot(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};

  for (const field of AUDITABLE_PRICING_FIELDS) {
    if (!(field in row)) continue;
    const value = row[field];
    snapshot[field] = typeof value === "bigint" ? value.toString() : value;
  }
  return snapshot;
}

/**
 * Fields that changed between two snapshots.
 *
 * Stored alongside the full before/after so a reader can see *what* changed
 * without diffing by eye, which is where mistakes happen during an incident.
 */
export function changed_fields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (before === null || after === null) return [];

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/** Build an actor descriptor from a derived context. Never from a request. */
export function actor_from_context(
  context: AuthenticatedTenantContext | PlatformAdminContext,
): AuditActor {
  if (context.kind === "platform_admin") {
    return {
      user_id: context.user_id,
      actor_type: "platform_admin",
      actor_role: null,
    };
  }
  return {
    user_id: context.user_id,
    actor_type: "authenticated",
    actor_role: context.role,
  };
}

/**
 * Append one audit row.
 *
 * @param tx a transaction client — **not** a `PrismaClient`. The type is the
 * enforcement: an audit row can only be written inside the transaction that
 * performs the mutation it describes.
 */
export async function write_audit(
  tx: Prisma.TransactionClient,
  entry: AuditEntry,
): Promise<void> {
  const changed = changed_fields(entry.old_value, entry.new_value);

  await tx.audit_logs.create({
    data: {
      tenant_id: entry.tenant_id,
      actor_user_id: entry.actor.user_id,
      actor_type: entry.actor.actor_type,
      actor_role: entry.actor.actor_role,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      // `Prisma.DbNull` rather than `undefined`: the column is genuinely null
      // for a creation (no before) or a deletion (no after), and `undefined`
      // would mean "leave unset", which reads the same but says something
      // different.
      old_value:
        entry.old_value === null
          ? Prisma.DbNull
          : (entry.old_value as Prisma.InputJsonValue),
      new_value:
        entry.new_value === null
          ? Prisma.DbNull
          : ((changed.length > 0
              ? { ...entry.new_value, __changed: changed }
              : entry.new_value) as Prisma.InputJsonValue),
      request_id: entry.request.request_id,
      ip_address: entry.request.ip_address,
      user_agent: entry.request.user_agent?.slice(0, 512) ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The audit view a tenant may read. No internal user ids, no raw rows. */
export interface AuditEntryView {
  readonly id: string;
  readonly action: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly actor_type: string | null;
  readonly actor_role: string | null;
  readonly changed_fields: readonly string[];
  readonly old_value: Record<string, unknown> | null;
  readonly new_value: Record<string, unknown> | null;
  readonly request_id: string | null;
  readonly created_at: string;
}

interface AuditRow {
  id: bigint;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_type: string | null;
  actor_role: string | null;
  old_value: unknown;
  new_value: unknown;
  request_id: string | null;
  created_at: Date;
}

/**
 * Project a stored row for reading.
 *
 * `actor_user_id`, `ip_address` and `user_agent` are deliberately withheld:
 * they are retained for incident response but are personal data that ordinary
 * dashboard users have no need to browse.
 */
export function to_audit_view(row: AuditRow): AuditEntryView {
  const raw_new = (row.new_value ?? null) as Record<string, unknown> | null;
  const changed =
    raw_new !== null && Array.isArray(raw_new["__changed"])
      ? (raw_new["__changed"] as string[])
      : [];

  const new_value = raw_new === null ? null : { ...raw_new };
  if (new_value !== null) delete new_value["__changed"];

  return {
    id: row.id.toString(),
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    actor_type: row.actor_type,
    actor_role: row.actor_role,
    changed_fields: changed,
    old_value: (row.old_value ?? null) as Record<string, unknown> | null,
    new_value,
    request_id: row.request_id,
    created_at: row.created_at.toISOString(),
  };
}
