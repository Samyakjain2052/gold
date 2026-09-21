/**
 * The authentication boundary.
 *
 * ```
 *   untrusted request
 *      │  Authorization: Bearer <token>        ← the ONLY input read
 *      ▼
 *   JwtVerifier.verify()                       signature, alg, iss, aud, exp,
 *      │                                       nbf, iat, kid, claims, subject
 *      ▼
 *   VerifiedPrincipal                          { supabase_user_id }  — no tenant
 *      │
 *      ▼
 *   derive_principal_context(db, principal)    trusted DB state
 *      │
 *      ▼
 *   AuthenticatedTenantContext | PlatformAdminContext
 *      │
 *      ▼
 *   req.auth_context                           what handlers may use
 * ```
 *
 * ## What this middleware does not read
 *
 * `req.body`, `req.query`, `req.params`, and every header other than
 * `Authorization`. A tenant identifier appearing in any of them has no path
 * into the context, because nothing here looks at them. That is why
 * `?tenantId=`, `{ "tenantId": … }`, `/t/:tenantId` and `X-Tenant-Id` are inert
 * — not filtered out, but never consulted.
 *
 * ## Failure semantics
 *
 * | Outcome | Status | Meaning |
 * |---|---|---|
 * | No or bad token | `401` | Not authenticated |
 * | Valid token, no membership | `403` | Authenticated, not authorised |
 * | Valid token, tenant suspended | `403` | Authenticated, access withdrawn |
 * | Signing keys unreachable | `503` | Our fault, not the caller's |
 *
 * `503` rather than `401` for a key-source outage is deliberate: answering
 * `401` would tell every client to re-authenticate, which cannot help and would
 * drive a login stampede during an incident.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../platform/logger.js";
import { AppError } from "../../platform/errors.js";
import {
  AuthenticationError,
  to_client_message,
  type VerifiedPrincipal,
} from "../../modules/auth/principal.js";
import {
  extract_bearer_token,
  type JwtVerifier,
} from "../../modules/auth/jwt_verifier.js";
import {
  derive_principal_context,
  TenantContextError,
  type AuthenticatedTenantContext,
  type PlatformAdminContext,
} from "../../modules/tenancy/tenant_context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set only by this middleware. Handlers must never assign it. */
      auth_context?: AuthenticatedTenantContext | PlatformAdminContext;
      principal?: VerifiedPrincipal;
    }
  }
}

export interface AuthenticateDependencies {
  readonly verifier: JwtVerifier;
  readonly db: PrismaClient;
  readonly logger: Logger;
}

/**
 * Log an authentication failure.
 *
 * Records the failure category and correlation metadata, never the token, the
 * `Authorization` header, or any claim contents. A category plus a request id
 * is enough to investigate; the token is not, and logging it would place a live
 * credential in the log store.
 */
function log_failure(
  logger: Logger,
  req: Request,
  category: string,
  detail: string,
): void {
  logger.warn(
    {
      event: "auth.failed",
      category,
      detail,
      request_id: req.request_id,
      method: req.method,
      // The matched route, not the raw URL — a raw URL can carry identifiers.
      endpoint: req.route?.path ?? req.path,
      timestamp: new Date().toISOString(),
    },
    "authentication failed",
  );
}

export function create_authenticate(deps: AuthenticateDependencies): RequestHandler {
  const { verifier, db, logger } = deps;

  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = extract_bearer_token(req.header("authorization"));

    if (token === null) {
      log_failure(logger, req, "missing_token", "no bearer token supplied");
      next(AppError.unauthenticated("Authentication required"));
      return;
    }

    let principal: VerifiedPrincipal;

    try {
      principal = await verifier.verify(token);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        log_failure(logger, req, error.reason, error.message);

        next(
          error.is_infrastructure_failure
            ? AppError.upstream_unavailable(to_client_message(error.reason))
            : AppError.unauthenticated(to_client_message(error.reason)),
        );
        return;
      }

      // Anything unrecognised is still an auth failure, not a 500 — an
      // unexpected verifier fault must not be reported as a server error the
      // caller could mistake for a transient glitch worth retrying with the
      // same token.
      log_failure(logger, req, "malformed_token", "verification failed");
      next(AppError.unauthenticated("Authentication required"));
      return;
    }

    try {
      // Identity established; now find what it is entitled to. Note that
      // nothing from the request participates.
      req.auth_context = await derive_principal_context(db, principal);
      req.principal = principal;
      next();
    } catch (error) {
      if (error instanceof TenantContextError) {
        log_failure(logger, req, `context.${error.code}`, error.message);
        // Authenticated but not authorised — 403, not 401. Re-authenticating
        // would not help, and telling the caller to try again would be a lie.
        next(AppError.forbidden("Not permitted"));
        return;
      }
      next(error);
    }
  };
}

/**
 * Read the context a handler must act under.
 *
 * Throws rather than returning undefined: a handler reaching this without the
 * middleware having run is a routing bug, and defaulting to "no context" would
 * turn it into a silent authorization hole.
 */
export function auth_context_of(
  req: Request,
): AuthenticatedTenantContext | PlatformAdminContext {
  const context = req.auth_context;
  if (context === undefined) {
    throw AppError.unauthenticated("Authentication required");
  }
  return context;
}
