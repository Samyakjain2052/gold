/**
 * `/api/v1/me` — who the caller is and which shop they are acting on.
 *
 * `ARCHITECTURE.md` §7 lists this as "Session user + tenant summary". The
 * dashboard needs three things before it can render anything: the firm's name,
 * the caller's role, and the public link to preview. All three are derived
 * server-side from the verified token; none is accepted from the client.
 *
 * It also returns the tenant's **slug**, which is what lets the dashboard show
 * "exactly what customers currently see" by reading the ordinary public
 * endpoints rather than a parallel preview API. That keeps one pricing
 * projection in the system instead of two that can disagree.
 *
 * The tenant UUID is deliberately **not** in the response. The browser has no
 * use for it — every authenticated route derives the tenant from the token —
 * and shipping it would invite client code to start passing it back.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { require_tenant_actor } from "../../modules/auth/authorization.js";
import { auth_context_of } from "../middleware/authenticate.js";
import { with_context } from "../../modules/tenancy/tenant_context.js";

export interface MeRouterDependencies {
  readonly db: PrismaClient;
}

export function create_me_router(deps: MeRouterDependencies): Router {
  const { db } = deps;
  const router = Router();

  router.get("/", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = require_tenant_actor(auth_context_of(req));

      const summary = await with_context(db, context, async (tx) => {
        const [tenant, branding, link] = await Promise.all([
          tx.tenants.findFirst({
            where: { id: context.tenant_id },
            select: { legal_name: true, status: true },
          }),
          tx.tenant_branding.findFirst({
            where: { tenant_id: context.tenant_id },
            select: { display_name: true, tagline: true, accent_color: true },
          }),
          // The active link only. A rotated one still exists in the table so
          // old URLs can answer 410, but it is not the shop's current address.
          //
          // Filtered on `is_active`, which is what `resolve_public_link`
          // actually decides revocation by. Filtering on `revoked_at` instead
          // looked equivalent and is not: the two columns can disagree, and the
          // dashboard would then advertise a link the public resolver answers
          // 410 for.
          tx.customer_links.findFirst({
            where: { tenant_id: context.tenant_id, is_active: true },
            select: { slug: true },
            orderBy: { created_at: "desc" },
          }),
        ]);

        return {
          user: {
            role: context.role,
          },
          tenant: {
            // Branding wins where set: it is the name the shop chose to show.
            // `legal_name` is the fallback only — it is the owner's own data and
            // safe here, but it is never part of the public surface.
            display_name: branding?.display_name ?? tenant?.legal_name ?? "",
            tagline: branding?.tagline ?? null,
            accent_color: branding?.accent_color ?? null,
            status: tenant?.status ?? "pending",
            /** null before the shopkeeper has been issued a customer link. */
            public_slug: link?.slug ?? null,
          },
        };
      });

      res.setHeader("Cache-Control", "no-store");
      res.json({ data: summary });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
