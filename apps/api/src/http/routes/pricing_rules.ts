/**
 * `/api/v1/pricing-rules` — the shopkeeper pricing configuration API.
 *
 * Handlers are deliberately thin. They validate input, extract the concurrency
 * precondition, and hand a **context** to the service. They never read a tenant
 * from the request, never build a context, and never touch the database
 * directly — all of that lives in the modules Stage 5 and 6 established.
 *
 * ## HTTP semantics
 *
 * | Situation | Status |
 * |---|---|
 * | Unparseable body | `400` (body parser) |
 * | Valid JSON failing validation, or an unknown field | `422` |
 * | No or invalid token | `401` |
 * | Authenticated, lacking the capability, or another tenant's rule | `403` |
 * | Missing `If-Match` on a conditional write | `428` |
 * | Stale version, duplicate active rule, key reuse | `409` |
 *
 * A cross-tenant rule returns the **same** `403` as a nonexistent one, so the
 * response cannot be used to discover which ids exist.
 *
 * `428 Precondition Required` is the one status outside the brief's list. It is
 * the correct answer to "you must quote a version and did not", and collapsing
 * it into `409` would tell a client their write conflicted when in fact they
 * never declared what they were overwriting.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../../platform/errors.js";
import { require_tenant_actor } from "../../modules/auth/authorization.js";
import { auth_context_of } from "../middleware/authenticate.js";
import {
  assert_valid_key,
  fingerprint_request,
} from "../../modules/idempotency/idempotency_service.js";
import {
  create_pricing_rule_request,
  update_pricing_rule_request,
} from "../../modules/pricing/pricing_rule_dto.js";
import {
  create_rule,
  deactivate_rule,
  get_rule,
  list_rules,
  update_rule,
  type MutationContext,
} from "../../modules/pricing/pricing_rule_service.js";

export interface PricingRouterDependencies {
  readonly db: PrismaClient;
  /**
   * Recomputes a rule's published customer rate inside the mutation's
   * transaction. Supplied by the composition root when a market pipeline is
   * running.
   *
   * Absent, a rule change still persists and is audited; the published rate is
   * refreshed by the next market tick instead. That is the documented
   * behaviour of a deployment with no feed, not a silent failure.
   */
  readonly recompute_rule?: (
    tx: Prisma.TransactionClient,
    tenant_id: string,
    rule_id: string,
  ) => Promise<boolean>;
}

const rule_id_param = z.uuid("rule id must be a UUID");

/**
 * Translate a Zod failure into a `422` naming every field at once.
 *
 * Reporting one field at a time turns a malformed form into a round-trip per
 * mistake.
 */
function to_validation_error(error: z.ZodError, message: string): AppError {
  return AppError.validation(
    message,
    error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  );
}

/**
 * Read the concurrency precondition.
 *
 * Required on every write that replaces existing state. Without it a client
 * cannot express *which* version it intends to overwrite, and a lost update
 * becomes possible the moment two people edit the same rule.
 */
function required_version(req: Request): number {
  const header = req.header("if-match");

  if (header === undefined || header.trim() === "") {
    throw new AppError(
      "PRECONDITION_REQUIRED",
      "If-Match is required: quote the rule's current version to avoid overwriting a concurrent change",
    );
  }

  // Accept both a bare version and a quoted ETag.
  const parsed = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (parsed === null) {
    throw AppError.validation("If-Match must be the rule's version number");
  }
  return Number(parsed[1]);
}

/** Request metadata carried into the audit row. */
function mutation_context(
  req: Request,
  deps: PricingRouterDependencies,
): MutationContext {
  const key = req.header("idempotency-key");

  const base = {
    request: {
      request_id: req.request_id ?? null,
      ip_address: req.ip ?? null,
      user_agent: req.header("user-agent") ?? null,
    },
    ...(deps.recompute_rule === undefined ? {} : { recompute: deps.recompute_rule }),
  };

  if (key === undefined || key.trim() === "") return base;

  assert_valid_key(key.trim());
  return {
    ...base,
    idempotency: {
      key: key.trim(),
      fingerprint: fingerprint_request(req.method, req.path, req.body),
    },
  };
}

function set_etag(res: Response, version: number): void {
  res.setHeader("ETag", `"${version}"`);
}

export function create_pricing_router(deps: PricingRouterDependencies): Router {
  const router = Router();
  const { db } = deps;

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      const rules = await list_rules(db, context);
      res.json({ data: rules, meta: { count: rules.length } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:rule_id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      const parsed = rule_id_param.safeParse(req.params["rule_id"]);
      // A malformed id is refused as `403`, matching a foreign id exactly — a
      // `422` here would confirm that well-formed ids are the ones worth trying.
      if (!parsed.success) throw AppError.forbidden("Not permitted");

      const rule = await get_rule(db, context, parsed.data);
      set_etag(res, rule.version);
      res.json({ data: rule });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));

      const parsed = create_pricing_rule_request.safeParse(req.body);
      if (!parsed.success) {
        throw to_validation_error(parsed.error, "Invalid pricing rule");
      }

      const { response, replayed } = await create_rule(
        db,
        context,
        parsed.data,
        mutation_context(req, deps),
      );

      set_etag(res, response.version);
      // A replay reports the original outcome; re-reporting `201` would imply a
      // second rule was created.
      res.status(replayed ? 200 : 201).json({ data: response, meta: { replayed } });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:rule_id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));

      const id = rule_id_param.safeParse(req.params["rule_id"]);
      if (!id.success) throw AppError.forbidden("Not permitted");

      const version = required_version(req);

      const parsed = update_pricing_rule_request.safeParse(req.body);
      if (!parsed.success) {
        throw to_validation_error(parsed.error, "Invalid pricing rule");
      }

      const { response, replayed } = await update_rule(
        db,
        context,
        id.data,
        version,
        parsed.data,
        mutation_context(req, deps),
      );

      set_etag(res, response.version);
      res.json({ data: response, meta: { replayed } });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:rule_id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));

      const id = rule_id_param.safeParse(req.params["rule_id"]);
      if (!id.success) throw AppError.forbidden("Not permitted");

      const version = required_version(req);

      const { response, replayed } = await deactivate_rule(
        db,
        context,
        id.data,
        version,
        mutation_context(req, deps),
      );

      set_etag(res, response.version);
      // 200 with the deactivated rule, not 204: the caller needs the new
      // version, and a soft delete leaves a resource worth returning.
      res.json({ data: response, meta: { replayed } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
