/**
 * Express application assembly.
 *
 * Security middleware order matters: headers and CORS before body parsing,
 * body limits before any handler, error rendering last.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import rate_limit from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import type { Logger } from "../platform/logger.js";
import { AppError, to_problem_body } from "../platform/errors.js";
import { create_health_router, type HealthDependencies } from "./routes/health.js";
import { create_pricing_router } from "./routes/pricing_rules.js";
import { create_audit_router } from "./routes/audit_logs.js";
import { create_public_router } from "./routes/public.js";
import { create_me_router } from "./routes/me.js";
import type { RateHub } from "../modules/realtime/rate_hub.js";
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
  /**
   * Realtime fan-out. Absent in compositions without Redis, in which case the
   * SSE route is not mounted at all — better an honest 404 than an endpoint
   * that accepts a connection and never delivers anything.
   */
  readonly hub?: RateHub;
  /**
   * The rate pipeline, when one is running. Supplies market-data health and the
   * recompute hook the pricing API uses to republish on a rule change.
   */
  readonly pipeline?: {
    health(): import("../platform/health.js").ComponentHealth;
    detail(): object;
    recompute_rule(
      tx: import("@prisma/client").Prisma.TransactionClient,
      tenant_id: string,
      rule_id: string,
    ): Promise<boolean>;
  };
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

  app.use(
    "/health",
    create_health_router({
      ...deps,
      ...(deps.pipeline === undefined
        ? {}
        : {
            market_data_probe: () => deps.pipeline!.health(),
            market_data_detail: () => deps.pipeline!.detail(),
          }),
      ...(deps.hub === undefined
        ? {}
        : {
            realtime: () => ({
              connections: deps.hub!.listener_count(),
              tenant_channels: deps.hub!.channel_count(),
            }),
          }),
    }),
  );

  // Public customer surface — no authentication by design. Mounted before the
  // authenticated API so it is obvious at a glance which routes are anonymous,
  // and so no `authenticate` middleware can accidentally be applied to it.
  //
  // Rate limited per IP: these are the only endpoints an unauthenticated
  // stranger can reach, so they are the ones that need a ceiling. The limiter is
  // in-memory rather than Redis-backed, which means the effective limit is
  // per-replica; that is the correct trade for a read-only endpoint where the
  // cost of an occasional extra request is a cache hit, not a mutation.
  if (deps.db !== undefined) {
    const public_limiter = rate_limit({
      windowMs: 60_000,
      limit: config.RATE_LIMIT_PUBLIC_PER_MIN,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      // The event stream is one long-lived request, not many; counting it
      // against a per-minute budget would let a single reconnect loop lock a
      // customer out of the page they are already reading.
      skip: (req: Request) => req.path.endsWith("/stream"),
      handler: (_req: Request, _res: Response, next: NextFunction) => {
        next(new AppError("RATE_LIMITED", "Too many requests"));
      },
    });

    app.use(
      "/api/v1/public",
      public_limiter,
      create_public_router({
        db: deps.db,
        config,
        logger,
        ...(deps.hub === undefined ? {} : { hub: deps.hub }),
      }),
    );
  }

  // Authenticated API. Mounted only when both a verifier and a database are
  // supplied: a route that requires identity must never exist without the
  // middleware that establishes it.
  if (deps.verifier !== undefined && deps.db !== undefined) {
    const authenticate = create_authenticate({
      verifier: deps.verifier,
      db: deps.db,
      logger,
    });

    /**
     * Authenticated responses are never stored by any cache.
     *
     * Applied at the mount rather than per handler, for the same reason
     * `authenticate` is: a new route must not be able to forget it. Express
     * sets no `Cache-Control` of its own, and `pricing_rules` sends an `ETag`,
     * which makes a response *heuristically* cacheable — a browser on a shared
     * showroom machine may then keep one tenant's pricing and audit history on
     * disk after the user has signed out.
     *
     * RFC 9111 §3.5 already stops a shared cache storing a response to a
     * request bearing `Authorization`, so this closes the private-cache half.
     */
    const no_store = (_req: Request, res: Response, next: NextFunction): void => {
      res.setHeader("Cache-Control", "no-store, private");
      next();
    };

    // `authenticate` is applied at mount, so no handler below can be reached
    // without a derived context — it cannot be forgotten on a new route.
    app.use("/api/v1/me", authenticate, no_store, create_me_router({ db: deps.db }));
    app.use(
      "/api/v1/pricing-rules",
      authenticate,
      no_store,
      create_pricing_router({
        db: deps.db,
        ...(deps.pipeline === undefined
          ? {}
          : { recompute_rule: deps.pipeline.recompute_rule.bind(deps.pipeline) }),
      }),
    );
    app.use(
      "/api/v1/audit-logs",
      authenticate,
      no_store,
      create_audit_router({ db: deps.db }),
    );
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
