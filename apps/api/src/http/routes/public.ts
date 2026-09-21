/**
 * `/api/v1/public/shops/:slug` — the anonymous customer surface.
 *
 * Three endpoints, exactly as `ARCHITECTURE.md` §7 specifies them. No new
 * architecture: the projections, the slug resolution and the realtime isolation
 * all already existed as services from Stages 4–6; this file is the HTTP
 * transport they never had.
 *
 * ## What makes this safe to expose without authentication
 *
 * The tenant is derived **server-side from the slug** by
 * `resolve_public_tenant`, and every read runs inside `with_context`, so RLS
 * scopes the queries. Nothing in the request selects a tenant except the slug,
 * and a slug the caller does not know is unguessable. There is no parameter
 * here that widens what a visitor can see.
 *
 * The response DTOs are allowlists built field by field in `public_service.ts`;
 * no database entity is ever spread into a response, so a column added to a
 * table later cannot appear on this surface by default.
 *
 * ## Status codes
 *
 * | Situation | Status |
 * |---|---|
 * | Unknown or malformed slug | `404` |
 * | Slug rotated by the shopkeeper | `410` |
 * | Too many requests from one IP | `429` |
 * | Replica at its realtime connection limit | `503` |
 *
 * `410` rather than `404` for a rotated link is deliberate and comes from the
 * service: a customer who bookmarked the old link is told it was replaced, not
 * that the shop does not exist.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppConfig } from "../../platform/config.js";
import type { Logger } from "../../platform/logger.js";
import { AppError } from "../../platform/errors.js";
import {
  get_public_rates,
  get_public_shop,
  resolve_public_tenant,
  PublicAccessError,
  type PublicServiceOptions,
} from "../../modules/public/public_service.js";
import { classify_age } from "../../modules/market_data/freshness.js";
import { RateHubCapacityError, type RateHub } from "../../modules/realtime/rate_hub.js";
import type { RateEvent } from "../../modules/realtime/rate_channel.js";

export interface PublicRouterDependencies {
  readonly db: PrismaClient;
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Absent in compositions without Redis; the stream route is then not mounted. */
  readonly hub?: RateHub;
}

/**
 * Slugs are lowercase words joined by single hyphens.
 *
 * Validated before it reaches the database so a hostile slug cannot become an
 * expensive query, and bounded at 64 so a multi-kilobyte path cannot be used to
 * probe the resolver.
 */
const slug_param = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "not a valid shop link");

function parse_slug(raw: unknown): string {
  const result = slug_param.safeParse(raw);
  if (!result.success) {
    // A malformed slug is reported as "not found", not as a validation error.
    // Telling a prober that their input was well-formed but unknown, versus
    // malformed, is a distinction that only helps them.
    throw new AppError("NOT_FOUND", "Shop not found");
  }
  return result.data;
}

/** Translate the service's public error into the standard problem envelope. */
function as_app_error(error: unknown): unknown {
  if (error instanceof PublicAccessError) {
    return error.status === 410
      ? new AppError("GONE", error.message)
      : new AppError("NOT_FOUND", error.message);
  }
  return error;
}

export function create_public_router(deps: PublicRouterDependencies): Router {
  const { db, config, logger, hub } = deps;
  const router = Router();

  const service_options: PublicServiceOptions = {
    logo_base_url: public_logo_base_url(config),
    classify: (source_timestamp: Date) =>
      classify_age(Date.now() - source_timestamp.getTime(), {
        stale_after_ms: config.FRESHNESS_STALE_AFTER_MS,
        expired_after_ms: config.FRESHNESS_EXPIRED_AFTER_MS,
      }),
  };

  router.get(
    "/shops/:slug",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const shop = await get_public_shop(db, parse_slug(req.params["slug"]), service_options);
        // A shop's branding changes rarely; a short shared cache absorbs the
        // burst when a link is broadcast. Rates below are deliberately not
        // cached this way.
        res.setHeader("Cache-Control", "public, max-age=60");
        res.json({ data: shop });
      } catch (error) {
        next(as_app_error(error));
      }
    },
  );

  router.get(
    "/shops/:slug/rates",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rates = await get_public_rates(db, parse_slug(req.params["slug"]), service_options);

        // Never cached by a shared cache. A rate is the whole point of the page
        // and a proxy serving a stale one would defeat the freshness model that
        // the payload itself reports.
        res.setHeader("Cache-Control", "no-store");
        res.json({
          data: rates,
          meta: {
            count: rates.length,
            /**
             * Surfaced so the UI can say, unmissably, that these numbers are
             * simulated. Production refuses to start with the mock provider, so
             * this can only ever be true outside production.
             */
            simulated: config.MARKET_DATA_PROVIDER === "mock",
            served_at: new Date().toISOString(),
          },
        });
      } catch (error) {
        next(as_app_error(error));
      }
    },
  );

  if (hub !== undefined) {
    router.get(
      "/shops/:slug/stream",
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        let slug: string;
        try {
          slug = parse_slug(req.params["slug"]);
        } catch (error) {
          next(error);
          return;
        }

        let detach: (() => Promise<void>) | null = null;

        try {
          // The context is derived from the slug exactly as the REST routes do.
          // The browser never names a tenant, so there is no id here to distrust.
          const context = await resolve_public_tenant(db, slug);

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            // Container Apps' ingress and any nginx in front of it will buffer
            // an event stream into uselessness without this.
            "X-Accel-Buffering": "no",
          });
          // Flush headers so EventSource fires `onopen` immediately rather than
          // when the first rate happens to change, which could be minutes.
          res.flushHeaders();

          const send = (event: string, payload: unknown): void => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
          };

          send("ready", { slug, simulated: config.MARKET_DATA_PROVIDER === "mock" });

          detach = await hub.attach(context, context.tenant_id, (event: RateEvent) => {
            // The tenant id is stripped rather than relayed. The browser has no
            // use for it, it is not part of the public vocabulary, and the page
            // already knows which shop it asked for.
            const { tenant_id: _omitted, ...public_fields } = event;
            send("rate_update", public_fields);
          });

          // Idle connections are dropped by Azure's ingress at around 240s, and
          // by many mobile networks sooner. A comment line is not an event, so
          // it keeps the socket warm without the client seeing anything.
          const heartbeat = setInterval(() => {
            res.write(`: keep-alive\n\n`);
          }, config.SSE_HEARTBEAT_MS);

          const cleanup = (): void => {
            clearInterval(heartbeat);
            void detach?.().catch((error: unknown) => {
              logger.warn({ err: error }, "failed to detach realtime listener");
            });
            detach = null;
          };

          req.on("close", cleanup);
          res.on("close", cleanup);
        } catch (error) {
          await detach?.().catch(() => {});

          if (error instanceof RateHubCapacityError) {
            // Shedding load is a server condition and a retry is reasonable, so
            // 503 with Retry-After rather than a 429 aimed at this client.
            res.setHeader("Retry-After", "5");
            next(new AppError("UPSTREAM_UNAVAILABLE", "Realtime capacity reached"));
            return;
          }

          // Headers may already be out; there is no way to turn an open event
          // stream into a problem document, so end it and let the browser retry.
          if (res.headersSent) {
            res.end();
            return;
          }
          next(as_app_error(error));
        }
      },
    );
  }

  return router;
}

/**
 * Public base URL for logo blobs, or null when storage is not configured.
 *
 * Built from the account and container names only. The connection string is
 * never involved: a URL that carried a SAS or key would put a storage
 * credential on an anonymous page.
 */
function public_logo_base_url(config: AppConfig): string | null {
  const account = config.AZURE_STORAGE_ACCOUNT_NAME;
  if (account === undefined || account === "") return null;
  return `https://${account}.blob.core.windows.net/${config.AZURE_STORAGE_CONTAINER_LOGOS}`;
}
