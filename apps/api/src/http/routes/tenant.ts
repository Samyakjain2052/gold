/**
 * `/api/v1/tenant` and `/api/v1/products` — a shop's own settings.
 *
 * Both act on the caller's tenant, which comes from the verified token. No
 * route here takes a tenant identifier, and the request schemas are `.strict()`
 * so supplying one is a `422` rather than something quietly ignored.
 *
 * Writes require `tenant:branding:write` (manager and above); reads require
 * `tenant:read` (staff). Pricing is deliberately not reachable from here — a
 * margin is a different decision under a different capability.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../platform/errors.js";
import { require_tenant_actor } from "../../modules/auth/authorization.js";
import { auth_context_of } from "../middleware/authenticate.js";
import {
  get_settings,
  update_settings,
  update_settings_request,
} from "../../modules/tenant/tenant_settings_service.js";
import {
  list_products,
  update_product,
  update_product_request,
} from "../../modules/tenant/tenant_products_service.js";
import type { AuditRequestContext } from "../../modules/audit/audit_service.js";
import { z } from "zod";

export interface TenantRouterDependencies {
  readonly db: PrismaClient;
  /** Recomputes a published rate when a display unit changes. */
  readonly recompute_rule?: (
    tx: Prisma.TransactionClient,
    tenant_id: string,
    rule_id: string,
  ) => Promise<boolean>;
}

const product_id_param = z.uuid("product id must be a UUID");

function audit_request(req: Request): AuditRequestContext {
  return {
    request_id: req.request_id ?? null,
    ip_address: req.ip ?? null,
    user_agent: req.header("user-agent") ?? null,
  };
}

/** Report every bad field at once; one per round trip is a miserable form. */
function validation_error(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): AppError {
  return AppError.validation(
    "Check the highlighted fields",
    issues.map((issue) => ({
      ...(issue.path.length > 0 ? { field: issue.path.map(String).join(".") } : {}),
      message: issue.message,
    })),
  );
}

export function create_tenant_router(deps: TenantRouterDependencies): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      res.json({ data: await get_settings(deps.db, context) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));

      const parsed = update_settings_request.safeParse(req.body);
      if (!parsed.success) {
        next(validation_error(parsed.error.issues));
        return;
      }

      const settings = await update_settings(
        deps.db,
        context,
        parsed.data,
        audit_request(req),
      );
      res.json({ data: settings });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function create_products_router(deps: TenantRouterDependencies): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      const products = await list_products(deps.db, context);
      res.json({ data: products, meta: { count: products.length } });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:product_id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));

      const id = product_id_param.safeParse(req.params["product_id"]);
      if (!id.success) {
        next(AppError.not_found("No such product"));
        return;
      }

      const parsed = update_product_request.safeParse(req.body);
      if (!parsed.success) {
        next(validation_error(parsed.error.issues));
        return;
      }

      const product = await update_product(
        deps.db,
        context,
        id.data,
        parsed.data,
        audit_request(req),
        deps.recompute_rule,
      );
      res.json({ data: product });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
