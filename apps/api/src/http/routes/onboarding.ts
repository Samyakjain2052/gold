/**
 * `/api/v1/onboarding` — turning a signed-in identity into a shop.
 *
 * The one authenticated route that does **not** sit behind `authenticate`.
 * That middleware derives a tenant context and correctly refuses a user who has
 * no membership — which is every user arriving here. So this route verifies the
 * token and stops there: it has a `principal` and no `auth_context`, and the
 * only tenant it touches is the one it creates.
 *
 * ## Status codes
 *
 * | Situation | Status |
 * |---|---|
 * | Shop created | `201` |
 * | No or invalid token | `401` |
 * | Unusable name or link | `422` |
 * | This account already has a shop | `409` |
 *
 * `409` rather than `422` for a repeat: nothing about the request is invalid,
 * it conflicts with state that already exists. A double-submitted form should
 * read as "you already have one", not "your input was wrong".
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../../platform/errors.js";
import type { Logger } from "../../platform/logger.js";
import { principal_of } from "../middleware/authenticate.js";
import {
  onboard_shopkeeper,
  OnboardingError,
  MAX_SLUG_LENGTH,
} from "../../modules/onboarding/onboarding_service.js";

export interface OnboardingRouterDependencies {
  readonly db: PrismaClient;
  readonly logger: Logger;
}

/**
 * Note what is absent: `tenant_id`, `user_id`, `role`, `status`. Identity comes
 * from the verified token and ownership is decided here, not requested.
 * `.strict()` turns an attempt to supply any of them into a `422`.
 */
const onboarding_request = z
  .object({
    shop_name: z.string().min(2).max(120),
    slug: z.string().min(3).max(MAX_SLUG_LENGTH).optional(),
  })
  .strict();

function to_status(code: OnboardingError["code"]): AppError {
  switch (code) {
    case "already_onboarded":
      return new AppError("CONFLICT", "This account already has a shop");
    case "slug_unavailable":
      return new AppError("CONFLICT", "That link is taken; please choose another");
    default:
      return new AppError("VALIDATION_ERROR", "Check the shop name and link");
  }
}

export function create_onboarding_router(deps: OnboardingRouterDependencies): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = principal_of(req);

      const parsed = onboarding_request.safeParse(req.body);
      if (!parsed.success) {
        next(
          AppError.validation(
            "Check the shop name and link",
            parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || undefined,
              message: issue.message,
            })) as { field?: string; message: string }[],
          ),
        );
        return;
      }

      const result = await onboard_shopkeeper(
        { db: deps.db, logger: deps.logger },
        principal,
        parsed.data,
      );

      res.status(201).json({ data: result });
    } catch (error) {
      if (error instanceof OnboardingError) {
        // The service's own message is safe to show: it describes the caller's
        // input, never internal state.
        const mapped = to_status(error.code);
        next(new AppError(mapped.code, error.message));
        return;
      }
      next(error);
    }
  });

  return router;
}
