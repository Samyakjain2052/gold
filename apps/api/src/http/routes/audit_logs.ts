/**
 * `/api/v1/audit-logs` — read-only.
 *
 * There is deliberately **no write, update or delete route**. Audit rows are
 * written only as part of the mutation they describe, inside that mutation's
 * transaction. An endpoint that could append to the audit log would let a
 * caller author history; one that could amend it would let a caller rewrite it.
 *
 * Reading is a `manager` capability, not `staff`: audit history exposes who
 * changed pricing and when, which is management information rather than
 * day-to-day operational data.
 *
 * Isolation is the same as everywhere else — the tenant comes from the derived
 * context, the query filters on it, and RLS filters again.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../platform/errors.js";
import {
  require_capability,
  require_tenant_actor,
} from "../../modules/auth/authorization.js";
import { auth_context_of } from "../middleware/authenticate.js";
import { with_context } from "../../modules/tenancy/tenant_context.js";
import { to_audit_view } from "../../modules/audit/audit_service.js";
import { list_audit_query } from "../../modules/pricing/pricing_rule_dto.js";

export interface AuditRouterDependencies {
  readonly db: PrismaClient;
}

const AUDIT_SELECT = {
  id: true,
  action: true,
  entity_type: true,
  entity_id: true,
  actor_type: true,
  actor_role: true,
  old_value: true,
  new_value: true,
  request_id: true,
  created_at: true,
} as const;

export function create_audit_router(deps: AuditRouterDependencies): Router {
  const router = Router();
  const { db } = deps;

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      require_capability(context, "tenant:audit:read");

      const parsed = list_audit_query.safeParse(req.query);
      if (!parsed.success) {
        throw AppError.validation(
          "Invalid audit query",
          parsed.error.issues.map((issue) => ({
            field: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        );
      }

      const { limit, cursor, entity_id } = parsed.data;

      const rows = await with_context(db, context, async (tx) =>
        tx.audit_logs.findMany({
          where: {
            tenant_id: context.tenant_id,
            ...(entity_id === undefined ? {} : { entity_id }),
            // Keyset pagination: `id` is monotonic, so this is stable under
            // concurrent inserts in a way `OFFSET` is not.
            ...(cursor === undefined ? {} : { id: { lt: BigInt(cursor) } }),
          },
          select: AUDIT_SELECT,
          orderBy: { id: "desc" },
          take: limit + 1,
        }),
      );

      const has_more = rows.length > limit;
      const page = has_more ? rows.slice(0, limit) : rows;

      res.json({
        data: page.map(to_audit_view),
        meta: {
          limit,
          has_more,
          next_cursor: has_more ? page[page.length - 1]?.id.toString() : null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
