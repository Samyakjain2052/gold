/**
 * Express application assembly.
 *
 * Security middleware order matters: headers and CORS before body parsing,
 * body limits before any handler, error rendering last.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import type { Logger } from "../platform/logger.js";
import { AppError, to_problem_body } from "../platform/errors.js";
import { create_health_router, type HealthDependencies } from "./routes/health.js";
import { create_pricing_router } from "./routes/pricing_rules.js";
import { create_audit_router } from "./routes/audit_logs.js";
import { create_authenticate } from "./middleware/authenticate.js";
import { AuthorizationError } from "../modules/auth/authorization.js";
import type { PrismaClient } from "@prisma/client";
import type { JwtVerifier } from "../modules/auth/jwt_verifier.js";

export interface AppDependencies extends HealthDependencies {
  readonly logger: Logger;
  /**
   * Present only when authentication is wired. Absent in the health-only
   * composition used by tests that need no identity — so the authenticated
   * routes are simply not mounted rather than mounted without a guard.
   */
  readonly db?: PrismaClient;
  readonly verifier?: JwtVerifier;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      request_id: string;
    }
  }
}

export function create_app(deps: AppDependencies): Express {
  const { config, logger } = deps;
  const app = express();

  // Behind Container Apps ingress: trust exactly one proxy hop so client IPs
  // used for rate limiting are real and cannot be spoofed by an X-Forwarded-For
  // header from the client.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // CSP is on by default in production; disabled locally so the dev tooling
  // and Next.js dev server are not blocked.
  app.use(config.is_production ? helmet() : helmet({ contentSecurityPolicy: false }));

  app.use(
    cors({
      origin: config.ALLOWED_ORIGINS,
      credentials: false, // Bearer-token API; no cookie auth, so no CSRF surface.
      maxAge: 600,
    }),
  );

  // Request ID on every request, echoed on every response and every log line.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const supplied = req.header("x-request-id");
    req.request_id = supplied && /^[\w-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader("x-request-id", req.request_id);
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.use("/health", create_health_router(deps));

  // Authenticated API. Mounted only when both a verifier and a database are
  // supplied: a route that requires identity must never exist without the
  // middleware that establishes it.
  if (deps.verifier !== undefined && deps.db !== undefined) {
    const authenticate = create_authenticate({
      verifier: deps.verifier,
      db: deps.db,
      logger,
    });

    // `authenticate` is applied at mount, so no handler below can be reached
    // without a derived context — it cannot be forgotten on a new route.
    app.use("/api/v1/pricing-rules", authenticate, create_pricing_router({ db: deps.db }));
    app.use("/api/v1/audit-logs", authenticate, create_audit_router({ db: deps.db }));
  }

  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(AppError.not_found(`No route for ${req.method} ${req.path}`));
  });

  // Error renderer — last, and the only place an error reaches the client.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    // An authorization failure is a 403, never a 500. Letting it fall through
    // to the generic handler would hide a policy decision inside the service's
    // error budget and tell the caller to retry something that will never work.
    const mapped =
      error instanceof AuthorizationError ? AppError.forbidden("Not permitted") : error;

    const body = to_problem_body(mapped, req.request_id ?? "unknown");

    // Full detail to logs (operator-facing), sanitised body to the client.
    if (body.status >= 500) {
      logger.error({ err: error, request_id: req.request_id }, "unhandled error");
    } else {
      logger.warn(
        { code: body.code, status: body.status, request_id: req.request_id },
        "request failed",
      );
    }

    res.status(body.status).type("application/problem+json").json(body);
  });

  return app;
}
