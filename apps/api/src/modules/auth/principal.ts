/**
 * The verified principal — the only output of JWT verification.
 *
 * Identity provider: **Microsoft Entra External ID** (CIAM). The type is
 * deliberately free of vendor naming beyond the claim semantics it must model.
 *
 * ## What is deliberately absent
 *
 * **There is no tenant-of-ours on this type.** Even if the token carried an
 * application `tenant_id` claim, it would not appear here: a claim asserts what
 * the token says, not what our database records. Our tenant identity is
 * resolved separately, from trusted database state, by the context layer.
 *
 * Note the two different meanings of "tenant" in play:
 *   - `directory_tenant_id` — Entra's `tid`, the **identity directory**. Part
 *     of the user's identity, and validated during verification.
 *   - our `tenant_id`      — the jewellery firm. Never from a token.
 *
 * ## Why the user key is `oid` + `tid`, not `sub`
 *
 * Entra issues **pairwise** subject identifiers: `sub` is unique per
 * (user, application) pair, so the same shopkeeper signing in through a second
 * app registration — a mobile app, an admin portal — would present a different
 * `sub` and look like a new user.
 *
 * `oid` (the directory object id) is stable for that user across every
 * application in the directory. Microsoft's guidance is to use `tid` + `oid`
 * together as the immutable key, and that is what `users.external_object_id`
 * and `users.external_directory_id` store.
 *
 * ## The chain
 *
 *   untrusted request
 *     → verify_access_token()   → VerifiedPrincipal   (this file)
 *     → derive_principal_context()                     (tenancy)
 *     → AuthenticatedTenantContext | PlatformAdminContext
 *     → service layer
 *     → RLS
 */

/**
 * A caller whose identity has been cryptographically verified.
 *
 * Construct only from {@link JwtVerifier}. Nothing else may produce one; a
 * hand-built principal would be an unverified assertion wearing a verified type.
 */
export interface VerifiedPrincipal {
  /**
   * Entra `oid` — the directory object id. Stable for this user across every
   * application in the directory. **The user key**, together with
   * `directory_tenant_id`.
   */
  readonly external_object_id: string;
  /**
   * Entra `tid` — the identity directory this user belongs to. Validated
   * against the expected directory during verification, so a token from
   * another Entra tenant cannot be replayed at us.
   */
  readonly directory_tenant_id: string;
  /**
   * Entra `sub` — **pairwise, per-application**. Retained for log correlation
   * only. Never used as a user key; see the note above.
   */
  readonly subject: string;
  /** `azp` / `appid` — the client application the token was issued to. */
  readonly client_id: string | null;
  readonly issuer: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  /** `jti` where present, for replay correlation in logs. */
  readonly token_id: string | null;
  /**
   * Scopes (`scp`) the token carries.
   *
   * **Not application roles.** A scope says what the client app was permitted
   * to request; it does not say what this user may do in our product. Our roles
   * come from `tenant_users.role` and `platform_admins`, resolved from the
   * database.
   */
  readonly scopes: readonly string[];
}

/** Why authentication failed. Drives status mapping and structured logging. */
export type AuthFailureReason =
  | "missing_token"
  | "malformed_token"
  | "unsupported_algorithm"
  | "invalid_signature"
  | "unknown_key"
  | "expired"
  | "not_yet_valid"
  | "issued_in_future"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_directory"
  | "wrong_client"
  | "missing_claim"
  | "invalid_subject"
  | "key_source_unavailable";

/**
 * Authentication failure.
 *
 * `reason` is for logs and metrics. The message returned to a caller is
 * deliberately coarse — see {@link to_client_message} — because distinguishing
 * "wrong issuer" from "bad signature" tells an attacker which part of a forged
 * token to fix next.
 */
export class AuthenticationError extends Error {
  constructor(
    readonly reason: AuthFailureReason,
    /** Operator-facing detail. Never contains the token or a header. */
    message: string,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }

  /**
   * True when the failure is ours, not the caller's.
   *
   * A JWKS endpoint that is unreachable is an infrastructure fault: answering
   * `401` would tell the client to re-authenticate, which cannot help and sends
   * them into a login loop during an outage.
   */
  get is_infrastructure_failure(): boolean {
    return this.reason === "key_source_unavailable";
  }
}

/** Every reason collapses to one of two client-visible messages. */
export function to_client_message(reason: AuthFailureReason): string {
  return reason === "key_source_unavailable"
    ? "Authentication is temporarily unavailable"
    : "Authentication required";
}
