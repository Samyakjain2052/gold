/**
 * JWT verification.
 *
 * Produces a {@link VerifiedPrincipal} and nothing else. It never builds a
 * tenant context, never reads a tenant claim, and never touches the database —
 * that separation is what keeps "who you are" distinct from "what you may act
 * on".
 *
 * ## What is checked
 *
 * | Check | Enforced by |
 * |---|---|
 * | Signature | `jose.jwtVerify` against the resolved key |
 * | Algorithm | Explicit allowlist passed to `jwtVerify` |
 * | Key selection (`kid`) | {@link JwksCache} resolver |
 * | Issuer | `issuer` option, exact match |
 * | Audience | `audience` option, exact match |
 * | Expiry (`exp`) | `jwtVerify`, with configurable clock tolerance |
 * | Not-before (`nbf`) | `jwtVerify` |
 * | Issued-at sanity (`iat`) | Explicit check below |
 * | Required claims | Explicit checks below |
 * | Subject shape | Explicit check below |
 *
 * ## Algorithm confusion
 *
 * The classic attack: a service configured for RS256 accepts a token whose
 * header says HS256, and verifies it using the *public* key as an HMAC secret —
 * which the attacker also has, since public keys are public. `alg: none` is the
 * degenerate case.
 *
 * Two defences, both required:
 *
 * 1. `algorithms` is an explicit allowlist handed to `jwtVerify`. A token whose
 *    header names anything else is rejected before a key is even selected.
 * 2. The allowlist is validated at construction to be **either** all-asymmetric
 *    **or** all-symmetric. Permitting both simultaneously is what makes the
 *    substitution possible in the first place, so the configuration cannot
 *    express it.
 *
 * ## Clock tolerance
 *
 * A small `clock_tolerance_s` (default 5s) absorbs ordinary skew between the
 * identity provider's host and ours. It is deliberately tiny: it widens the
 * window in which an expired token is still accepted, so it buys interoperation
 * at a real, bounded cost.
 */
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Clock } from "../../platform/clock.js";
import {
  AuthenticationError,
  type VerifiedPrincipal,
} from "./principal.js";

/** Asymmetric algorithms this service will accept. */
export const ASYMMETRIC_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "EdDSA",
] as const;

/** Symmetric algorithms, for Supabase's legacy shared-secret projects. */
export const SYMMETRIC_ALGORITHMS = ["HS256", "HS384", "HS512"] as const;

export type SupportedAlgorithm =
  | (typeof ASYMMETRIC_ALGORITHMS)[number]
  | (typeof SYMMETRIC_ALGORITHMS)[number];

export interface JwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly SupportedAlgorithm[];
  /**
   * Expected Entra directory (`tid`).
   *
   * **Required, and load-bearing.** Signature, issuer and audience alone do not
   * pin a token to *our* directory: with a multi-tenant app registration, a
   * token minted in any Entra tenant can carry the same audience and a valid
   * Microsoft signature. Microsoft names this the confused-deputy problem and
   * directs applications to match `tid` exactly.
   */
  readonly expected_directory_id: string;
  /**
   * Client applications permitted to call this API (`azp` / `appid`).
   * Empty means any client within the expected directory.
   */
  readonly allowed_client_ids: readonly string[];
  /** Seconds of tolerated clock skew on `exp` / `nbf`. */
  readonly clock_tolerance_s: number;
  /** Reject tokens claiming to be issued more than this far ahead. */
  readonly max_future_iat_s: number;
  /** Reject tokens older than this regardless of `exp`. 0 disables. */
  readonly max_token_age_s: number;
}

export const DEFAULT_VERIFIER_OPTIONS = {
  clock_tolerance_s: 5,
  max_future_iat_s: 60,
  max_token_age_s: 0,
} as const;

export class JwtVerifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtVerifierConfigError";
  }
}

function is_asymmetric(algorithm: string): boolean {
  return (ASYMMETRIC_ALGORITHMS as readonly string[]).includes(algorithm);
}

function is_symmetric(algorithm: string): boolean {
  return (SYMMETRIC_ALGORITHMS as readonly string[]).includes(algorithm);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate an algorithm allowlist.
 *
 * Rejects an empty list, unknown algorithms (including `none`), and — the
 * important one — any list mixing asymmetric and symmetric algorithms.
 */
export function assert_valid_algorithms(
  algorithms: readonly string[],
): asserts algorithms is readonly SupportedAlgorithm[] {
  if (algorithms.length === 0) {
    throw new JwtVerifierConfigError("at least one algorithm must be permitted");
  }

  for (const algorithm of algorithms) {
    if (!is_asymmetric(algorithm) && !is_symmetric(algorithm)) {
      throw new JwtVerifierConfigError(
        `algorithm "${algorithm}" is not supported` +
          (algorithm.toLowerCase() === "none"
            ? " — unsigned tokens are never accepted"
            : ""),
      );
    }
  }

  const has_asymmetric = algorithms.some(is_asymmetric);
  const has_symmetric = algorithms.some(is_symmetric);

  if (has_asymmetric && has_symmetric) {
    throw new JwtVerifierConfigError(
      "algorithms must be all-asymmetric or all-symmetric; permitting both " +
        "enables algorithm-confusion attacks, where a public key is replayed " +
        "as an HMAC secret",
    );
  }
}

/** Extract a bearer token. Returns null rather than throwing on absence. */
export function extract_bearer_token(header: string | undefined): string | null {
  if (header === undefined) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export class JwtVerifier {
  readonly #get_key: JWTVerifyGetKey;
  readonly #options: JwtVerifierOptions;
  readonly #clock: Clock;

  constructor(
    get_key: JWTVerifyGetKey,
    options: JwtVerifierOptions,
    clock: Clock,
  ) {
    assert_valid_algorithms(options.algorithms);
    this.#get_key = get_key;
    this.#options = options;
    this.#clock = clock;
  }

  /**
   * Verify a raw token.
   *
   * @throws {AuthenticationError} — always, on any failure. The reason is for
   * logs; the caller-visible message is deliberately coarse.
   */
  async verify(token: string): Promise<VerifiedPrincipal> {
    if (token.trim() === "") {
      throw new AuthenticationError("missing_token", "no token supplied");
    }

    let payload: JWTPayload;

    try {
      const result = await jwtVerify(token, this.#get_key, {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
        // The allowlist. A token whose header names anything else is rejected
        // before key selection, which is what defeats algorithm confusion.
        algorithms: [...this.#options.algorithms],
        clockTolerance: this.#options.clock_tolerance_s,
        currentDate: this.#clock.date(),
        ...(this.#options.max_token_age_s > 0
          ? { maxTokenAge: this.#options.max_token_age_s }
          : {}),
      });
      payload = result.payload;
    } catch (error) {
      // An AuthenticationError from the key resolver (unknown kid, JWKS down)
      // already carries the right reason; keep it rather than flattening it.
      if (error instanceof AuthenticationError) throw error;
      throw to_authentication_error(error);
    }

    return this.#to_principal(payload);
  }

  #to_principal(payload: JWTPayload): VerifiedPrincipal {
    const { sub, oid, tid, azp, appid, iat, exp, iss, jti, scp } = payload;

    if (typeof sub !== "string" || sub.trim() === "") {
      throw new AuthenticationError("missing_claim", "token has no subject");
    }

    // `oid` is the user key, not `sub` — Entra subjects are pairwise per
    // application, so `sub` changes for the same person under a second app
    // registration. See principal.ts.
    if (typeof oid !== "string" || oid.trim() === "") {
      throw new AuthenticationError(
        "missing_claim",
        "token has no object id (oid); cannot identify the user stably",
      );
    }
    if (!UUID_PATTERN.test(oid)) {
      throw new AuthenticationError(
        "invalid_subject",
        "token object id is not a UUID",
      );
    }

    // Directory pinning. Without this, a validly signed token from any other
    // Entra directory bearing our audience would be accepted.
    if (typeof tid !== "string" || tid.trim() === "") {
      throw new AuthenticationError(
        "missing_claim",
        "token has no directory id (tid)",
      );
    }
    if (tid.toLowerCase() !== this.#options.expected_directory_id.toLowerCase()) {
      throw new AuthenticationError(
        "wrong_directory",
        "token was issued by a different identity directory",
      );
    }

    if (typeof exp !== "number") {
      throw new AuthenticationError("missing_claim", "token has no expiry");
    }
    if (typeof iat !== "number") {
      throw new AuthenticationError("missing_claim", "token has no issued-at");
    }

    // `jwtVerify` checks exp and nbf but not whether iat is plausible. A token
    // claiming to be issued well in the future signals a broken or hostile
    // issuer, and would otherwise survive every other check.
    const now_s = Math.floor(this.#clock.now() / 1000);
    if (iat > now_s + this.#options.max_future_iat_s) {
      throw new AuthenticationError(
        "issued_in_future",
        "token issued-at is implausibly far in the future",
      );
    }

    // `azp` (v2.0) or `appid` (v1.0) names the client the token was minted for.
    // Pinning it stops a token issued to some other app in the same directory
    // being replayed against this API.
    const client_id =
      typeof azp === "string" ? azp : typeof appid === "string" ? appid : null;

    if (this.#options.allowed_client_ids.length > 0) {
      if (client_id === null) {
        throw new AuthenticationError(
          "wrong_client",
          "token does not name a client application",
        );
      }
      const permitted = this.#options.allowed_client_ids.some(
        (allowed) => allowed.toLowerCase() === client_id.toLowerCase(),
      );
      if (!permitted) {
        throw new AuthenticationError(
          "wrong_client",
          "token was issued to a client application that may not call this API",
        );
      }
    }

    return {
      external_object_id: oid,
      directory_tenant_id: tid,
      subject: sub,
      client_id,
      issuer: typeof iss === "string" ? iss : this.#options.issuer,
      issued_at: new Date(iat * 1000),
      expires_at: new Date(exp * 1000),
      token_id: typeof jti === "string" ? jti : null,
      scopes: typeof scp === "string" ? scp.split(" ").filter(Boolean) : [],
    };
  }
}

/** Map a `jose` error onto our failure taxonomy. */
function to_authentication_error(error: unknown): AuthenticationError {
  const code = (error as { code?: string }).code ?? "";
  const message = error instanceof Error ? error.message : "verification failed";

  switch (code) {
    case "ERR_JWT_EXPIRED":
      return new AuthenticationError("expired", "token has expired");
    case "ERR_JWT_CLAIM_VALIDATION_FAILED": {
      const claim = (error as { claim?: string }).claim;
      if (claim === "iss") {
        return new AuthenticationError("wrong_issuer", "unexpected issuer");
      }
      if (claim === "aud") {
        return new AuthenticationError("wrong_audience", "unexpected audience");
      }
      if (claim === "nbf") {
        return new AuthenticationError("not_yet_valid", "token is not yet valid");
      }
      if (claim === "iat") {
        return new AuthenticationError("issued_in_future", "implausible issued-at");
      }
      return new AuthenticationError("missing_claim", `claim check failed: ${claim}`);
    }
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return new AuthenticationError("invalid_signature", "signature is invalid");
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return new AuthenticationError(
        "unsupported_algorithm",
        "token algorithm is not permitted",
      );
    case "ERR_JWKS_NO_MATCHING_KEY":
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
      return new AuthenticationError(
        "unknown_key",
        "no usable signing key for this token",
      );
    case "ERR_JWKS_TIMEOUT":
      return new AuthenticationError(
        "key_source_unavailable",
        "timed out loading signing keys",
      );
    case "ERR_JWS_INVALID":
    case "ERR_JWT_INVALID":
      return new AuthenticationError("malformed_token", "token is malformed");
    default:
      // Unmapped failures are treated as malformed rather than as
      // infrastructure faults: defaulting to 503 would let a crafted token
      // masquerade as an outage.
      return new AuthenticationError("malformed_token", message);
  }
}
