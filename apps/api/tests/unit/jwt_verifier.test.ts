/**
 * JWT verification security tests.
 *
 * Tokens are signed with real, locally generated keypairs — never stubbed
 * verification. A test that mocks `jwtVerify` proves only that a mock was
 * called; these prove that a forged token is actually rejected.
 */
import { beforeAll, describe, expect, test } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";
import { ManualClock } from "../../src/platform/clock.js";
import {
  assert_valid_algorithms,
  extract_bearer_token,
  AuthenticationError,
  JwtVerifier,
  JwtVerifierConfigError,
  to_client_message,
  type AuthFailureReason,
  type JwtVerifierOptions,
} from "../../src/modules/auth/index.js";

const ISSUER = "https://project.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const SUBJECT = "6f1c2f3a-1111-4111-8111-1c2f3a6f1c2f";
const OBJECT_ID = "7a2d3e4b-2222-4222-8222-2d3e4b7a2d3e";
const DIRECTORY_ID = "0d1e2c70-0000-4000-8000-000000000001";
const OTHER_DIRECTORY_ID = "99999999-9999-4999-8999-999999999999";
const CLIENT_ID = "8b3e4f5c-3333-4333-8333-3e4f5c8b3e4f";
const NOW = new Date("2026-09-20T12:00:00.000Z");

interface Keypair {
  readonly kid: string;
  readonly private_key: CryptoKey;
  readonly jwk: JWK;
}

let key_a: Keypair;
let key_b: Keypair;
let hmac_secret: Uint8Array;

async function make_keypair(kid: string, alg = "ES256"): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return { kid, private_key: privateKey, jwk: { ...jwk, kid, alg, use: "sig" } };
}

beforeAll(async () => {
  key_a = await make_keypair("key-a");
  key_b = await make_keypair("key-b");
  hmac_secret = new TextEncoder().encode("a-shared-secret-of-adequate-length!!");
});

const options: JwtVerifierOptions = {
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ["ES256"],
  expected_directory_id: DIRECTORY_ID,
  allowed_client_ids: [],
  clock_tolerance_s: 5,
  max_future_iat_s: 60,
  max_token_age_s: 0,
};

function verifier_for(keys: readonly JWK[], overrides: Partial<JwtVerifierOptions> = {}) {
  const clock = new ManualClock(NOW);
  const jwks = createLocalJWKSet({ keys: [...keys] });
  return {
    clock,
    verifier: new JwtVerifier(jwks, { ...options, ...overrides }, clock),
  };
}

interface TokenOptions {
  readonly key?: Keypair;
  readonly alg?: string;
  readonly kid?: string | undefined;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string | undefined;
  readonly directory_id?: string;
  readonly issued_at?: number;
  readonly expires_at?: number;
  readonly not_before?: number;
  readonly extra_claims?: Record<string, unknown>;
}

async function sign_token(opts: TokenOptions = {}): Promise<string> {
  const now_s = Math.floor(NOW.getTime() / 1000);
  const key = opts.key ?? key_a;
  const alg = opts.alg ?? "ES256";

  let jwt = new SignJWT({
    // Entra-shaped: `oid` is the stable user key, `tid` the directory.
    oid: OBJECT_ID,
    tid: opts.directory_id ?? DIRECTORY_ID,
    azp: CLIENT_ID,
    scp: "rates.read",
    ...(opts.extra_claims ?? {}),
  })
    .setProtectedHeader({
      alg,
      ...(opts.kid === undefined ? { kid: key.kid } : { kid: opts.kid }),
    })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt(opts.issued_at ?? now_s)
    .setExpirationTime(opts.expires_at ?? now_s + 3600);

  if (opts.subject !== undefined) jwt = jwt.setSubject(opts.subject);
  if (opts.not_before !== undefined) jwt = jwt.setNotBefore(opts.not_before);

  return jwt.sign(key.private_key);
}

async function expect_rejection(
  token: string,
  reason: string,
  keys: readonly JWK[] = [key_a.jwk],
  overrides: Partial<JwtVerifierOptions> = {},
): Promise<AuthenticationError> {
  const { verifier } = verifier_for(keys, overrides);
  try {
    await verifier.verify(token);
    expect.unreachable(`expected rejection with reason "${reason}"`);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).reason).toBe(reason);
    return error as AuthenticationError;
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------

describe("1. valid token", () => {
  test("Verify_validToken_producesVerifiedPrincipal", async () => {
    const { verifier } = verifier_for([key_a.jwk]);
    const principal = await verifier.verify(await sign_token({ subject: SUBJECT }));

    expect(principal.external_object_id).toBe(OBJECT_ID);
    expect(principal.issuer).toBe(ISSUER);
    expect(principal.directory_tenant_id).toBe(DIRECTORY_ID);
    expect(principal.subject).toBe(SUBJECT);
    expect(principal.expires_at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  /**
   * The Stage 5 invariant, at the type level: a tenant claim in the token does
   * not survive verification. The principal has no tenant field at all, so
   * there is nothing for a forged claim to populate.
   */
  test("Verify_tokenCarryingTenantClaim_doesNotSurfaceItOnThePrincipal", async () => {
    const { verifier } = verifier_for([key_a.jwk]);
    const principal = await verifier.verify(
      await sign_token({
        subject: SUBJECT,
        extra_claims: {
          tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          app_metadata: { tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        },
      }),
    );

    expect(principal).not.toHaveProperty("tenant_id");
    expect(principal).not.toHaveProperty("tenantId");
    // The forged application-tenant claim reaches nothing.
    expect(JSON.stringify(principal)).not.toContain("aaaaaaaa");
  });

  test("Verify_validToken_doesNotTreatAuthRoleAsAnApplicationRole", async () => {
    const { verifier } = verifier_for([key_a.jwk]);
    // A token claiming an elevated provider role confers nothing: application
    // roles come from the database, not from the token.
    const principal = await verifier.verify(
      await sign_token({ subject: SUBJECT, extra_claims: { roles: ["admin"] } }),
    );

    // Scopes describe what the CLIENT was permitted to request, not what the
    // user may do here. Our roles come from the database.
    expect(principal.scopes).toEqual(["rates.read"]);
    expect(principal).not.toHaveProperty("role");
    expect(principal).not.toHaveProperty("is_platform_admin");
  });
});

describe("2. expired token", () => {
  test("Verify_expiredToken_isRejected", async () => {
    const past = Math.floor(NOW.getTime() / 1000) - 7200;
    await expect_rejection(
      await sign_token({ subject: SUBJECT, issued_at: past, expires_at: past + 60 }),
      "expired",
    );
  });

  test("Verify_tokenExpiredWithinClockTolerance_isAccepted", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    const { verifier } = verifier_for([key_a.jwk]);
    // Expired 3s ago, tolerance 5s.
    const principal = await verifier.verify(
      await sign_token({ subject: SUBJECT, issued_at: now_s - 60, expires_at: now_s - 3 }),
    );
    expect(principal.external_object_id).toBe(OBJECT_ID);
  });

  test("Verify_tokenExpiredBeyondClockTolerance_isRejected", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    await expect_rejection(
      await sign_token({ subject: SUBJECT, issued_at: now_s - 60, expires_at: now_s - 30 }),
      "expired",
    );
  });
});

describe("3. invalid signature", () => {
  test("Verify_tokenSignedByUnknownKey_isRejected", async () => {
    // Signed with key B, but only key A is published.
    await expect_rejection(
      await sign_token({ subject: SUBJECT, key: key_b, kid: key_a.kid }),
      "invalid_signature",
    );
  });

  test("Verify_tamperedPayload_isRejected", async () => {
    const token = await sign_token({ subject: SUBJECT });
    const [header, , signature] = token.split(".");
    const forged_payload = Buffer.from(
      JSON.stringify({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE, exp: 9_999_999_999 }),
    ).toString("base64url");

    await expect_rejection(
      `${header}.${forged_payload}.${signature}`,
      "invalid_signature",
    );
  });
});

describe("4. wrong issuer", () => {
  test("Verify_wrongIssuer_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, issuer: "https://evil.example/auth/v1" }),
      "wrong_issuer",
    );
  });

  test("Verify_issuerPrefixOfExpected_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, issuer: "https://project.supabase.co" }),
      "wrong_issuer",
    );
  });
});

describe("5. wrong audience", () => {
  test("Verify_wrongAudience_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, audience: "some-other-service" }),
      "wrong_audience",
    );
  });
});

describe("6. unsupported algorithm", () => {
  /**
   * Algorithm confusion: a service configured for ES256 must not accept an
   * HS256 token, even one signed with a key the attacker controls.
   */
  test("Verify_hmacTokenAgainstAsymmetricVerifier_isRejected", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    const hmac_token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: key_a.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setIssuedAt(now_s)
      .setExpirationTime(now_s + 3600)
      .sign(hmac_secret);

    await expect_rejection(hmac_token, "unsupported_algorithm");
  });

  test("Verify_algNone_isRejected", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: SUBJECT,
        iss: ISSUER,
        aud: AUDIENCE,
        iat: now_s,
        exp: now_s + 3600,
      }),
    ).toString("base64url");

    const { verifier } = verifier_for([key_a.jwk]);
    await expect(verifier.verify(`${header}.${payload}.`)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  test("Verify_differentAsymmetricAlgorithmThanAllowed_isRejected", async () => {
    const rs_key = await make_keypair("rs-key", "RS256");
    await expect_rejection(
      await sign_token({ subject: SUBJECT, key: rs_key, alg: "RS256" }),
      "unsupported_algorithm",
      [rs_key.jwk],
    );
  });

  describe("configuration refuses confusable algorithm lists", () => {
    test("AssertValidAlgorithms_mixedAsymmetricAndSymmetric_throws", () => {
      expect(() => assert_valid_algorithms(["ES256", "HS256"])).toThrow(
        /algorithm-confusion/,
      );
    });

    test("AssertValidAlgorithms_none_throws", () => {
      expect(() => assert_valid_algorithms(["none"])).toThrow(/unsigned tokens/);
    });

    test("AssertValidAlgorithms_empty_throws", () => {
      expect(() => assert_valid_algorithms([])).toThrow(JwtVerifierConfigError);
    });

    test("AssertValidAlgorithms_allAsymmetric_isAccepted", () => {
      expect(() => assert_valid_algorithms(["ES256", "RS256"])).not.toThrow();
    });

    test("AssertValidAlgorithms_allSymmetric_isAccepted", () => {
      expect(() => assert_valid_algorithms(["HS256", "HS512"])).not.toThrow();
    });

    test("JwtVerifier_constructedWithMixedAlgorithms_throws", () => {
      const clock = new ManualClock(NOW);
      const jwks = createLocalJWKSet({ keys: [key_a.jwk] });
      expect(
        () =>
          new JwtVerifier(jwks, { ...options, algorithms: ["ES256", "HS256"] }, clock),
      ).toThrow(JwtVerifierConfigError);
    });
  });
});

describe("7. missing subject / object id", () => {
  test("Verify_tokenWithoutSubject_isRejected", async () => {
    await expect_rejection(await sign_token({ subject: undefined }), "missing_claim");
  });

  test("Verify_tokenWithoutObjectId_isRejected", async () => {
    // `oid` is the user key. Without it there is no stable identity to resolve,
    // even though `sub` is present and the signature is valid.
    await expect_rejection(
      await sign_token({ subject: SUBJECT, extra_claims: { oid: undefined } }),
      "missing_claim",
    );
  });

  test("Verify_nonUuidObjectId_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, extra_claims: { oid: "not-a-uuid" } }),
      "invalid_subject",
    );
  });

  test("Verify_emptySubject_isRejected", async () => {
    await expect_rejection(await sign_token({ subject: "   " }), "missing_claim");
  });
});

/**
 * Directory pinning — the confused-deputy defence.
 *
 * Signature, issuer and audience alone do not pin a token to OUR directory: a
 * multi-tenant app registration means a token minted in any Entra tenant can
 * carry the same audience and a genuine Microsoft signature.
 */
describe("directory (tid) pinning", () => {
  test("Verify_tokenFromAnotherDirectory_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, directory_id: OTHER_DIRECTORY_ID }),
      "wrong_directory",
    );
  });

  test("Verify_tokenWithoutDirectoryClaim_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, extra_claims: { tid: undefined } }),
      "missing_claim",
    );
  });

  test("Verify_directoryComparison_isCaseInsensitive", async () => {
    const { verifier } = verifier_for([key_a.jwk]);
    const principal = await verifier.verify(
      await sign_token({ subject: SUBJECT, directory_id: DIRECTORY_ID.toUpperCase() }),
    );
    expect(principal.directory_tenant_id.toLowerCase()).toBe(DIRECTORY_ID);
  });
});

describe("client (azp) pinning", () => {
  test("Verify_tokenFromAnUnlistedClient_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT }),
      "wrong_client",
      [key_a.jwk],
      { allowed_client_ids: ["11111111-1111-4111-8111-111111111111"] },
    );
  });

  test("Verify_tokenFromAnAllowedClient_isAccepted", async () => {
    const { verifier } = verifier_for([key_a.jwk], {
      allowed_client_ids: [CLIENT_ID],
    });
    const principal = await verifier.verify(await sign_token({ subject: SUBJECT }));
    expect(principal.client_id).toBe(CLIENT_ID);
  });

  test("Verify_noClientClaimWhenClientsArePinned_isRejected", async () => {
    await expect_rejection(
      await sign_token({ subject: SUBJECT, extra_claims: { azp: undefined } }),
      "wrong_client",
      [key_a.jwk],
      { allowed_client_ids: [CLIENT_ID] },
    );
  });

  test("Verify_emptyAllowedClients_permitsAnyInDirectoryClient", async () => {
    const { verifier } = verifier_for([key_a.jwk], { allowed_client_ids: [] });
    await expect(
      verifier.verify(await sign_token({ subject: SUBJECT })),
    ).resolves.toBeDefined();
  });
});

describe("8. malformed token", () => {
  test.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["single segment", "abcdef"],
    ["two segments", "abc.def"],
    ["four segments", "a.b.c.d"],
    ["not base64", "!!!.???.***"],
    ["json but not a jwt", '{"sub":"x"}'],
  ])("Verify_malformed_%s_isRejected", async (_label, token) => {
    const { verifier } = verifier_for([key_a.jwk]);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("Verify_errorMessage_neverContainsTheToken", async () => {
    const token = await sign_token({ subject: SUBJECT, issuer: "https://evil.test" });
    const error = await expect_rejection(token, "wrong_issuer");

    expect(error.message).not.toContain(token);
    expect(error.message.length).toBeLessThan(200);
  });
});

describe("not-before and issued-at", () => {
  test("Verify_tokenNotYetValid_isRejected", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    await expect_rejection(
      await sign_token({ subject: SUBJECT, not_before: now_s + 600 }),
      "not_yet_valid",
    );
  });

  /** A token issued far in the future signals a broken or hostile issuer. */
  test("Verify_issuedAtImplausiblyInFuture_isRejected", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    await expect_rejection(
      await sign_token({
        subject: SUBJECT,
        issued_at: now_s + 3600,
        expires_at: now_s + 7200,
      }),
      "issued_in_future",
    );
  });

  test("Verify_issuedAtSlightlyAhead_isAccepted", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    const { verifier } = verifier_for([key_a.jwk]);
    const principal = await verifier.verify(
      await sign_token({ subject: SUBJECT, issued_at: now_s + 10 }),
    );
    expect(principal.external_object_id).toBe(OBJECT_ID);
  });

  /**
   * An absolute age cap catches a token whose `exp` is far in the future — a
   * long-lived credential that outlives any reasonable session. Reported as
   * `expired`, which is what "too old to use" means to a caller.
   */
  test("Verify_maxTokenAge_rejectsOldButUnexpiredTokens", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    await expect_rejection(
      await sign_token({
        subject: SUBJECT,
        issued_at: now_s - 86_400,
        expires_at: now_s + 3600,
      }),
      "expired",
      [key_a.jwk],
      { max_token_age_s: 3600 },
    );
  });

  test("Verify_maxTokenAgeDisabled_acceptsAnOldButUnexpiredToken", async () => {
    const now_s = Math.floor(NOW.getTime() / 1000);
    const { verifier } = verifier_for([key_a.jwk], { max_token_age_s: 0 });
    const principal = await verifier.verify(
      await sign_token({
        subject: SUBJECT,
        issued_at: now_s - 86_400,
        expires_at: now_s + 3600,
      }),
    );
    expect(principal.external_object_id).toBe(OBJECT_ID);
  });
});

describe("client-visible messages", () => {
  /**
   * Every failure reason collapses to one of two messages. Distinguishing
   * "wrong issuer" from "bad signature" would tell an attacker which part of a
   * forged token to fix next; the precise reason goes to logs only.
   */
  test("ToClientMessage_everyCallerFault_saysOnlyAuthenticationRequired", () => {
    const caller_faults: AuthFailureReason[] = [
      "missing_token",
      "malformed_token",
      "unsupported_algorithm",
      "invalid_signature",
      "unknown_key",
      "expired",
      "not_yet_valid",
      "issued_in_future",
      "wrong_issuer",
      "wrong_audience",
      "missing_claim",
      "invalid_subject",
    ];

    for (const reason of caller_faults) {
      expect(to_client_message(reason), reason).toBe("Authentication required");
    }
    expect(new Set(caller_faults.map(to_client_message)).size).toBe(1);
  });

  test("ToClientMessage_infrastructureFault_saysTemporarilyUnavailable", () => {
    expect(to_client_message("key_source_unavailable")).toBe(
      "Authentication is temporarily unavailable",
    );
  });

  test("AuthenticationError_onlyKeySourceIsAnInfrastructureFailure", () => {
    expect(
      new AuthenticationError("key_source_unavailable", "x").is_infrastructure_failure,
    ).toBe(true);
    expect(new AuthenticationError("expired", "x").is_infrastructure_failure).toBe(
      false,
    );
    expect(
      new AuthenticationError("invalid_signature", "x").is_infrastructure_failure,
    ).toBe(false);
  });
});

describe("bearer token extraction", () => {
  test.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer abc.def.ghi", "abc.def.ghi"],
    ["BEARER abc.def.ghi", "abc.def.ghi"],
    ["  Bearer   abc.def.ghi  ", "abc.def.ghi"],
  ])("ExtractBearerToken_%s_extracts", (header, expected) => {
    expect(extract_bearer_token(header)).toBe(expected);
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["no scheme", "abc.def.ghi"],
    ["wrong scheme", "Basic abc"],
    ["scheme only", "Bearer"],
    ["two tokens", "Bearer a b"],
  ])("ExtractBearerToken_%s_returnsNull", (_label, header) => {
    expect(extract_bearer_token(header)).toBeNull();
  });
});
