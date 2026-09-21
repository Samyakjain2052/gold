/**
 * The complete authentication chain, end to end against a real database.
 *
 *   signed JWT → JwtVerifier → VerifiedPrincipal
 *              → derive_principal_context → TenantContext
 *              → service layer → RLS transaction → rows
 *
 * Every layer is exercised together rather than separately, because the risk
 * this stage exists to remove lives in the *seams*: each layer can be correct
 * while the chain still lets a caller choose their own tenant.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { pino } from "pino";
import { randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";
import type { PrismaClient } from "@prisma/client";
import { ManualClock } from "../../src/platform/clock.js";
import { AppError, to_problem_body } from "../../src/platform/errors.js";
import {
  JwtVerifier,
  AuthenticationError,
  require_capability,
  require_tenant_actor,
  AuthorizationError,
  type JwtVerifierOptions,
} from "../../src/modules/auth/index.js";
import {
  derive_principal_context,
  derive_public_context,
  TenantContextError,
} from "../../src/modules/tenancy/tenant_context.js";
import {
  create_authenticate,
  auth_context_of,
} from "../../src/http/middleware/authenticate.js";
import { list_rules, get_rule } from "../../src/modules/pricing/pricing_rule_service.js";
import {
  app_client,
  owner_client,
  seed_fixtures,
  TEST_DIRECTORY_ID,
  type Fixtures,
} from "./fixtures.js";

const ISSUER = "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0";
const AUDIENCE = "api://bullion-rates";
const NOW = new Date("2026-09-20T12:00:00.000Z");

let owner: PrismaClient;
let app_db: PrismaClient;
let fx: Fixtures;
let signing_key: CryptoKey;
let jwk: JWK;
let clock: ManualClock;
let verifier: JwtVerifier;
let api: Express;

const silent_logger = pino({ level: "silent" });

const verifier_options: JwtVerifierOptions = {
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ["ES256"],
  expected_directory_id: TEST_DIRECTORY_ID,
  allowed_client_ids: [],
  clock_tolerance_s: 5,
  max_future_iat_s: 60,
  max_token_age_s: 0,
};

/** Mint a token for a principal, exactly as the identity provider would. */
async function token_for(
  external_object_id: string,
  extra_claims: Record<string, unknown> = {},
): Promise<string> {
  const now_s = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({
    oid: external_object_id,
    tid: TEST_DIRECTORY_ID,
    ...extra_claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    // `sub` is pairwise per application and is NOT the user key.
    .setSubject(`pairwise-${external_object_id}`)
    .setIssuedAt(now_s)
    .setExpirationTime(now_s + 3600)
    .sign(signing_key);
}

/**
 * A minimal API exercising the real middleware.
 *
 * The routes deliberately accept tenant identifiers in the URL, body, query and
 * headers — and then ignore them — so the tests can prove those inputs are
 * inert rather than merely unused.
 */
function build_api(): Express {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.request_id = "test-request";
    next();
  });

  const authenticate = create_authenticate({
    verifier,
    db: app_db,
    logger: silent_logger,
  });

  server.get("/api/v1/whoami", authenticate, (req, res) => {
    const context = auth_context_of(req);
    res.json({ data: context });
  });

  // Tenant id present in the path, and never consulted.
  server.get("/api/v1/t/:tenantId/pricing-rules", authenticate, async (req, res, next) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      require_capability(context, "tenant:pricing:read");
      const rules = await list_rules(app_db, context);
      // The DTO no longer exposes tenant_id (Stage 7). The tenant is echoed
      // from the CONTEXT so the test can assert which tenant was resolved.
      res.json({
        data: rules.map((r) => ({ id: r.id, tenant_id: context.tenant_id })),
      });
    } catch (error) {
      next(error);
    }
  });

  server.post("/api/v1/pricing-rules/read", authenticate, async (req, res, next) => {
    try {
      const context = require_tenant_actor(auth_context_of(req));
      require_capability(context, "tenant:pricing:read");
      const rules = await list_rules(app_db, context);
      res.json({ data: { tenant_id: context.tenant_id, count: rules.length } });
    } catch (error) {
      next(error);
    }
  });

  server.get("/api/v1/admin/tenants", authenticate, (req, res, next) => {
    try {
      const context = auth_context_of(req);
      require_capability(context, "platform:tenants:read");
      res.json({ data: { ok: true } });
    } catch (error) {
      next(error);
    }
  });

  server.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const mapped =
        error instanceof AuthorizationError
          ? AppError.forbidden("Not permitted")
          : error;
      const body = to_problem_body(mapped, req.request_id ?? "test-request");
      res.status(body.status).type("application/problem+json").json(body);
    },
  );

  return server;
}

beforeAll(async () => {
  owner = owner_client();
  app_db = app_client();
  fx = await seed_fixtures(owner);

  const pair = await generateKeyPair("ES256", { extractable: true });
  signing_key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256", use: "sig" };

  clock = new ManualClock(NOW);
  verifier = new JwtVerifier(
    createLocalJWKSet({ keys: [jwk] }),
    verifier_options,
    clock,
  );
  api = build_api();
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), app_db.$disconnect()]);
});

// ---------------------------------------------------------------------------
// The full chain
// ---------------------------------------------------------------------------

describe("end-to-end: JWT → principal → context → RLS → rows", () => {
  test("AuthChain_tenantAToken_readsOnlyTenantARowsThroughEveryLayer", async () => {
    // 1. A token, as the identity provider would issue it.
    const token = await token_for(fx.tenant_a.external_object_id);

    // 2. Verification yields a principal carrying no tenant.
    const principal = await verifier.verify(token);
    expect(principal.external_object_id).toBe(fx.tenant_a.external_object_id);
    expect(principal).not.toHaveProperty("tenant_id");

    // 3. Context derivation consults the database, not the token.
    const context = await derive_principal_context(app_db, principal);
    expect(context.kind).toBe("authenticated");
    if (context.kind !== "authenticated") throw new Error("unreachable");
    expect(context.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(context.role).toBe("owner");

    // 4. The service runs under RLS bound to that tenant.
    const rules = await list_rules(app_db, context);
    expect(rules.length).toBeGreaterThan(0);
    // Identity is proven by which rules came back, since the DTO withholds
    // tenant_id by design.
    expect(rules.some((r) => r.id === fx.tenant_a.gold_rule_id)).toBe(true);
    expect(rules.some((r) => r.id === fx.tenant_b.gold_rule_id)).toBe(false);

    // 5. And the row that exists for tenant B is unreachable.
    await expect(
      get_rule(app_db, context, fx.tenant_b.gold_rule_id),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("AuthChain_tenantBToken_readsOnlyTenantBRows", async () => {
    const principal = await verifier.verify(
      await token_for(fx.tenant_b.external_object_id),
    );
    const context = await derive_principal_context(app_db, principal);
    if (context.kind !== "authenticated") throw new Error("unreachable");

    expect(context.tenant_id).toBe(fx.tenant_b.tenant_id);
    const rules = await list_rules(app_db, context);
    expect(rules.some((r) => r.id === fx.tenant_b.gold_rule_id)).toBe(true);
    expect(rules.some((r) => r.id === fx.tenant_a.gold_rule_id)).toBe(false);
  });

  test("AuthChain_overHttp_returnsTenantAOnly", async () => {
    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", `Bearer ${await token_for(fx.tenant_a.external_object_id)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(response.body.data.kind).toBe("authenticated");
  });
});

// ---------------------------------------------------------------------------
// THE invariant
// ---------------------------------------------------------------------------

describe("REGRESSION: tenant identity comes from verified identity + membership", () => {
  /**
   * The Stage 5 invariant, stated as one test.
   *
   * Tenant A's user presents a token stuffed with tenant B claims, and calls a
   * route carrying tenant B in the path, the body, the query string and a
   * custom header — every channel a caller controls, at once. The resulting
   * context must still be tenant A.
   */
  test("Invariant_everyCallerControlledTenantInput_isIgnored", async () => {
    const hostile_token = await token_for(fx.tenant_a.external_object_id, {
      tenant_id: fx.tenant_b.tenant_id,
      tenantId: fx.tenant_b.tenant_id,
      app_metadata: { tenant_id: fx.tenant_b.tenant_id },
      role: "service_role",
    });

    const response = await request(api)
      .get(`/api/v1/t/${fx.tenant_b.tenant_id}/pricing-rules`)
      .query({ tenantId: fx.tenant_b.tenant_id, tenant_id: fx.tenant_b.tenant_id })
      .set("Authorization", `Bearer ${hostile_token}`)
      .set("X-Tenant-Id", fx.tenant_b.tenant_id)
      .set("X-Tenant", fx.tenant_b.tenant_id);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(
      response.body.data.every(
        (r: { tenant_id: string }) => r.tenant_id === fx.tenant_a.tenant_id,
      ),
    ).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant_b.tenant_id);
  });

  test("Invariant_tenantIdInUrlPath_doesNotChangeContext", async () => {
    const token = await token_for(fx.tenant_a.external_object_id);

    for (const path_tenant of [fx.tenant_b.tenant_id, randomUUID(), "not-a-uuid"]) {
      const response = await request(api)
        .get(`/api/v1/t/${path_tenant}/pricing-rules`)
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(
        response.body.data.every(
          (r: { tenant_id: string }) => r.tenant_id === fx.tenant_a.tenant_id,
        ),
      ).toBe(true);
    }
  });

  test("Invariant_tenantIdInRequestBody_doesNotChangeContext", async () => {
    const response = await request(api)
      .post("/api/v1/pricing-rules/read")
      .set("Authorization", `Bearer ${await token_for(fx.tenant_a.external_object_id)}`)
      .send({ tenantId: fx.tenant_b.tenant_id, tenant_id: fx.tenant_b.tenant_id });

    expect(response.body.data.tenant_id).toBe(fx.tenant_a.tenant_id);
  });

  test("Invariant_tenantIdInQueryString_doesNotChangeContext", async () => {
    const response = await request(api)
      .get("/api/v1/whoami")
      .query({ tenantId: fx.tenant_b.tenant_id })
      .set("Authorization", `Bearer ${await token_for(fx.tenant_a.external_object_id)}`);

    expect(response.body.data.tenant_id).toBe(fx.tenant_a.tenant_id);
  });

  test("Invariant_forgedTenantHeaders_doNotChangeContext", async () => {
    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", `Bearer ${await token_for(fx.tenant_a.external_object_id)}`)
      .set("X-Tenant-Id", fx.tenant_b.tenant_id)
      .set("X-Tenant-Slug", fx.tenant_b.slug)
      .set("X-Forwarded-Tenant", fx.tenant_b.tenant_id);

    expect(response.body.data.tenant_id).toBe(fx.tenant_a.tenant_id);
  });

  test("Invariant_tenantClaimInsideTheSignedToken_isNotAuthoritative", async () => {
    // Even a *validly signed* token asserting tenant B confers nothing: the
    // claim is not read, so its authenticity is beside the point.
    const principal = await verifier.verify(
      await token_for(fx.tenant_a.external_object_id, {
        tenant_id: fx.tenant_b.tenant_id,
      }),
    );
    const context = await derive_principal_context(app_db, principal);

    if (context.kind !== "authenticated") throw new Error("unreachable");
    expect(context.tenant_id).toBe(fx.tenant_a.tenant_id);
  });

  test("Invariant_membershipChangeInDatabase_changesContext", async () => {
    // The corollary: because the context comes from the database, changing the
    // database changes it — while the token stays byte-identical.
    const token = await token_for(fx.tenant_a.external_object_id);
    const before = await derive_principal_context(app_db, await verifier.verify(token));
    if (before.kind !== "authenticated") throw new Error("unreachable");
    expect(before.role).toBe("owner");

    await owner.tenant_users.update({
      where: {
        tenant_id_user_id: {
          tenant_id: fx.tenant_a.tenant_id,
          user_id: fx.tenant_a.user_id,
        },
      },
      data: { role: "staff" },
    });

    const after = await derive_principal_context(app_db, await verifier.verify(token));
    if (after.kind !== "authenticated") throw new Error("unreachable");
    expect(after.role).toBe("staff");

    await owner.tenant_users.update({
      where: {
        tenant_id_user_id: {
          tenant_id: fx.tenant_a.tenant_id,
          user_id: fx.tenant_a.user_id,
        },
      },
      data: { role: "owner" },
    });
  });
});

// ---------------------------------------------------------------------------
// Context derivation outcomes
// ---------------------------------------------------------------------------

describe("context derivation", () => {
  test("Derivation_userWithNoMembership_isRejected", async () => {
    const orphan = await owner.users.create({
      data: {
        external_object_id: randomUUID(),
        external_directory_id: TEST_DIRECTORY_ID,
        email: `orphan-${randomUUID()}@test.invalid`,
      },
    });

    const principal = await verifier.verify(await token_for(orphan.external_object_id));
    await expect(derive_principal_context(app_db, principal)).rejects.toThrow(
      TenantContextError,
    );

    await owner.users.delete({ where: { id: orphan.id } });
  });

  test("Derivation_unknownPrincipal_isRejected", async () => {
    const principal = await verifier.verify(await token_for(randomUUID()));
    await expect(derive_principal_context(app_db, principal)).rejects.toThrow(
      /not a known user/,
    );
  });

  test("Derivation_platformAdmin_yieldsPlatformAdminContextNotATenantOne", async () => {
    const admin_user = await owner.users.create({
      data: {
        external_object_id: randomUUID(),
        external_directory_id: TEST_DIRECTORY_ID,
        email: `admin-${randomUUID()}@test.invalid`,
      },
    });
    await owner.platform_admins.create({ data: { user_id: admin_user.id } });

    const principal = await verifier.verify(
      await token_for(admin_user.external_object_id),
    );
    const context = await derive_principal_context(app_db, principal);

    expect(context.kind).toBe("platform_admin");
    expect(context).not.toHaveProperty("tenant_id");

    await owner.platform_admins.delete({ where: { user_id: admin_user.id } });
    await owner.users.delete({ where: { id: admin_user.id } });
  });

  test("Derivation_suspendedTenant_isRejected", async () => {
    await owner.tenants.update({
      where: { id: fx.tenant_b.tenant_id },
      data: { status: "suspended" },
    });

    const principal = await verifier.verify(
      await token_for(fx.tenant_b.external_object_id),
    );
    await expect(derive_principal_context(app_db, principal)).rejects.toThrow(
      /suspended/,
    );

    await owner.tenants.update({
      where: { id: fx.tenant_b.tenant_id },
      data: { status: "active" },
    });
  });
});

// ---------------------------------------------------------------------------
// Failure semantics over HTTP
// ---------------------------------------------------------------------------

describe("failure semantics", () => {
  test("Http_noToken_returns401", async () => {
    const response = await request(api).get("/api/v1/whoami");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
  });

  test("Http_malformedToken_returns401NotServerError", async () => {
    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", "Bearer not.a.jwt");

    expect(response.status).toBe(401);
    expect(response.status).not.toBe(500);
  });

  test("Http_expiredToken_returns401", async () => {
    const past = Math.floor(NOW.getTime() / 1000) - 7200;
    const expired = await new SignJWT({ oid: fx.tenant_a.external_object_id, tid: TEST_DIRECTORY_ID })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(`pairwise-${fx.tenant_a.external_object_id}`)
      .setIssuedAt(past)
      .setExpirationTime(past + 60)
      .sign(signing_key);

    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", `Bearer ${expired}`);

    expect(response.status).toBe(401);
  });

  /** Authenticated but not authorised is 403 — re-authenticating cannot help. */
  test("Http_validTokenNoMembership_returns403Not401", async () => {
    const orphan = await owner.users.create({
      data: {
        external_object_id: randomUUID(),
        external_directory_id: TEST_DIRECTORY_ID,
        email: `orphan2-${randomUUID()}@test.invalid`,
      },
    });

    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", `Bearer ${await token_for(orphan.external_object_id)}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");

    await owner.users.delete({ where: { id: orphan.id } });
  });

  test("Http_shopkeeperAttemptingPlatformAdminOperation_returns403", async () => {
    const response = await request(api)
      .get("/api/v1/admin/tenants")
      .set("Authorization", `Bearer ${await token_for(fx.tenant_a.external_object_id)}`);

    expect(response.status).toBe(403);
  });

  test("Http_errorBodies_neverEchoTheToken", async () => {
    const token = await token_for(fx.tenant_a.external_object_id);
    const response = await request(api)
      .get("/api/v1/admin/tenants")
      .set("Authorization", `Bearer ${token}`);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain("Bearer");
    expect(serialised).not.toContain(fx.tenant_a.external_object_id);
  });

  test("Http_everyAuthFailure_carriesARequestIdAndNoDetail", async () => {
    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", "Bearer garbage");

    expect(response.body.request_id).toBe("test-request");
    // A coarse message: distinguishing failure modes tells an attacker which
    // part of a forged token to fix next.
    expect(response.body.detail).toBe("Authentication required");
  });
});

// ---------------------------------------------------------------------------
// Public context stays separate
// ---------------------------------------------------------------------------

describe("public customer context is not an authentication path", () => {
  test("PublicContext_cannotBeUsedForAnAuthenticatedOperation", async () => {
    const public_context = await derive_public_context(app_db, fx.tenant_a.slug);

    // Structurally refused: a public context is not a tenant actor.
    expect(() => require_tenant_actor(public_context)).toThrow(AuthorizationError);
    expect(() => require_capability(public_context, "tenant:pricing:write")).toThrow(
      AuthorizationError,
    );
  });

  test("PublicSlug_presentedAsABearerToken_isRejected", async () => {
    const response = await request(api)
      .get("/api/v1/whoami")
      .set("Authorization", `Bearer ${fx.tenant_a.slug}`);

    expect(response.status).toBe(401);
  });

  test("PublicContext_carriesNoUserOrRole", async () => {
    const public_context = await derive_public_context(app_db, fx.tenant_a.slug);
    expect(public_context).not.toHaveProperty("user_id");
    expect(public_context).not.toHaveProperty("role");
  });

  /** The two derivations are separate functions with separate inputs. */
  test("Derivation_publicAndAuthenticated_takeDifferentInputs", async () => {
    // A slug is not a principal; a principal is not a slug.
    await expect(
      derive_public_context(app_db, fx.tenant_a.external_object_id),
    ).rejects.toThrow(TenantContextError);

    const principal = await verifier.verify(await token_for(fx.tenant_a.external_object_id));
    const authenticated = await derive_principal_context(app_db, principal);
    expect(authenticated.kind).toBe("authenticated");
  });
});

describe("verifier rejects tokens the chain must never see", () => {
  test("Chain_tokenFromAnotherIssuer_neverReachesContextDerivation", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    const foreign = await new SignJWT({ oid: fx.tenant_a.external_object_id, tid: TEST_DIRECTORY_ID })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer("https://attacker.example/auth/v1")
      .setAudience(AUDIENCE)
      .setSubject(`pairwise-${fx.tenant_a.external_object_id}`)
      .setIssuedAt(now_s)
      .setExpirationTime(now_s + 3600)
      .sign(signing_key);

    await expect(verifier.verify(foreign)).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("Chain_tokenSignedByAnotherKey_neverReachesContextDerivation", async () => {
    const other = await generateKeyPair("ES256", { extractable: true });
    const now_s = Math.floor(NOW.getTime() / 1000);
    const forged = await new SignJWT({ oid: fx.tenant_a.external_object_id, tid: TEST_DIRECTORY_ID })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(`pairwise-${fx.tenant_a.external_object_id}`)
      .setIssuedAt(now_s)
      .setExpirationTime(now_s + 3600)
      .sign(other.privateKey);

    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(AuthenticationError);
  });
});
