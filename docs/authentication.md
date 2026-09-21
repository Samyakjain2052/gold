# Authentication and the Context Boundary

> **The invariant:** authenticated tenant identity comes from verified identity
> plus trusted membership resolution — **never** from a caller-controlled
> `tenant_id`.

Implemented in [`apps/api/src/modules/auth/`](../apps/api/src/modules/auth/) and
[`src/http/middleware/authenticate.ts`](../apps/api/src/http/middleware/authenticate.ts).
Downstream isolation: [tenant-isolation.md](tenant-isolation.md).

---

## 1. The chain

```
UNTRUSTED REQUEST
   │  Authorization: Bearer <token>          ← the only input read
   ▼
JwtVerifier.verify()                          signature · algorithm · kid
   │                                          iss · aud · exp · nbf · iat
   │                                          required claims · subject shape
   ▼
VerifiedPrincipal                             { oid, tid, … }
   │                                          ⚠ NO TENANT ON THIS TYPE
   ▼
derive_principal_context(db, principal)       resolve_principal_identity()
   │                                          trusted database state
   ▼
AuthenticatedTenantContext | PlatformAdminContext
   │
   ▼
service layer                                 require_capability()
   │
   ▼
with_context() → SET app.current_tenant_id    transaction-scoped
   │
   ▼
PostgreSQL RLS                                final filter
```

Each arrow narrows trust. Nothing flows backwards, and no step consults the
request again after the first.

### Why the principal carries no tenant

`VerifiedPrincipal` has no tenant field. Not stripped, not ignored — **absent
from the type**. A claim asserts what a token *says*; membership is what the
database *records*. Because the tenant never reaches the principal,
`derive_principal_context` cannot read one from a token even by mistake.

This holds even for a validly signed token asserting a tenant: authenticity is
beside the point when the value is never read.
`Invariant_tenantClaimInsideTheSignedToken_isNotAuthoritative` pins it down.

### Why the middleware reads nothing else

`create_authenticate` touches exactly one input: the `Authorization` header. It
never reads `req.body`, `req.query`, `req.params`, or any other header.
`?tenantId=`, `{"tenantId":…}`, `/t/:tenantId` and `X-Tenant-Id` are therefore
**inert** — not filtered, never consulted. That distinction matters: a filter
can be forgotten when a new field appears; a code path that does not exist
cannot be.

---

## 2. JWT verification

Provider: **Microsoft Entra External ID** (CIAM). Supabase was replaced because
this deployment is Azure-only; the verifier was built vendor-neutral, so the
swap changed configuration and claim names, not the verification logic.

### Resolved against the live tenant — not guessed

Read from the actual Entra discovery document for directory `57e7a430-333c-4343-b7a1-028ba15a58df`:

| Property | Verified value |
|---|---|
| Algorithm | **RS256 only** (`id_token_signing_alg_values_supported: ["RS256"]`) |
| JWKS | `…/discovery/v2.0/keys`, reachable |
| Key type | All published keys `kty: RSA`, `use: sig` |
| Symmetric keys | **None.** Zero `oct` keys — no legacy HS256 anywhere |
| Rotation | 6 overlapping keys, selected by `kid` |
| Subject type | `pairwise` — see below |

`AUTH_JWT_ALGORITHMS` therefore defaults to `RS256`. The all-asymmetric-or-
all-symmetric rule still holds, and a startup check now also rejects an
**algorithm/key-source mismatch**: asymmetric algorithms without a JWKS, or a
symmetric allowlist pointed *at* a JWKS.

> The values above were read from the **workforce** tenant that exists today.
> The production **External ID** tenant does not exist yet, so no production
> issuer or audience has been invented — those variables are blank in
> `.env.example` and production refuses to boot without them.

| Check | Enforced by |
|---|---|
| Signature | `jose.jwtVerify` against the resolved key |
| Algorithm | Explicit allowlist passed to `jwtVerify` |
| Key selection (`kid`) | `JwksCache` resolver |
| Issuer (`iss`) | Exact match |
| Audience (`aud`) | Exact match |
| Expiry (`exp`) | With configurable clock tolerance |
| Not-before (`nbf`) | `jwtVerify` |
| Issued-at sanity (`iat`) | Explicit — rejects implausibly future tokens |
| Absolute token age | Optional `AUTH_MAX_TOKEN_AGE_S` |
| Required claims | `sub`, `oid`, `tid`, `exp`, `iat` |
| Subject shape | `oid` must be a UUID |
| **Directory (`tid`)** | **Exact match against `AUTH_DIRECTORY_ID`** |
| Client (`azp`/`appid`) | Match against `AUTH_ALLOWED_CLIENT_IDS` when set |

### Directory pinning — the confused-deputy defence

Signature, issuer and audience alone do **not** pin a token to our directory.
With a multi-tenant app registration, a token minted in *any* Entra tenant can
carry the same audience and a genuine Microsoft signature. Microsoft names this
the confused-deputy problem and directs applications to match `tid` exactly.

`AUTH_DIRECTORY_ID` is required in production for that reason, and
`Verify_tokenFromAnotherDirectory_isRejected` proves it.

### Why the user key is `oid` + `tid`, not `sub`

Entra issues **pairwise** subject identifiers: `sub` is unique per
(user, application) pair. The same shopkeeper signing in through a second app
registration — a mobile app, an admin portal — would present a different `sub`
and look like a new user.

`oid` (directory object id) is stable across every application in the directory.
Microsoft's guidance is to use `tid` + `oid` together as the immutable key, and
that pair is what `users.external_directory_id` / `users.external_object_id`
store. `sub` is retained on the principal for log correlation only.

### Algorithm confusion

The classic attack: a service configured for RS256 accepts a token whose header
says HS256 and verifies it using the **public** key as an HMAC secret — which
the attacker also has, because public keys are public. `alg: none` is the
degenerate case.

Two defences, both required:

1. `algorithms` is an explicit allowlist handed to `jwtVerify`. A token naming
   anything else is rejected *before* a key is selected.
2. The allowlist is validated at construction and at startup to be **either
   all-asymmetric or all-symmetric**. Permitting both is what makes the
   substitution possible, so the configuration cannot express it.

`AUTH_JWT_ALGORITHMS=ES256,HS256` refuses to boot.

### Clock tolerance

`AUTH_CLOCK_TOLERANCE_S` defaults to **5 seconds** and is capped at 120. It
absorbs ordinary host skew, and is deliberately tiny because it widens the
window in which an expired token is still accepted — real interoperation, at a
real and bounded cost.

---

## 3. JWKS caching and key rotation

Verification runs on every authenticated request. Fetching the key set each time
would put the identity provider on the critical path of every call and take the
API down whenever they have a bad minute.

| Situation | Behaviour |
|---|---|
| Cache fresh, `kid` present | Serve from cache, no network |
| Cache fresh, `kid` unknown | Refresh **if** past cooldown, else reject |
| Cache older than `cache_max_age_ms` | Refresh before use |
| Refresh fails, cache within `stale_grace_ms` | **Serve stale keys**, count and log |
| Refresh fails, no usable cache | Fail closed → `503` |
| Refresh succeeds | Replace the set wholesale |

Concurrent cold requests share a single outbound fetch.

### The cooldown is load-bearing

An unknown `kid` signals rotation, so it triggers a refresh. But **`kid` is
attacker-controlled**: anyone can send tokens bearing random `kid`s. Without a
cooldown each forged token would trigger an outbound fetch, turning a trivial
request flood into a denial-of-service against the identity provider and, through
it, against us.

`AUTH_JWKS_COOLDOWN_MS` caps refreshes to one per window regardless of how many
unknown kids arrive.
`JwksCache_floodOfForgedKids_isRateLimitedToOneFetch` sends fifty forged kids and
asserts at most one fetch results.

### Stale grace, and why 24 hours

During a provider outage, continuing to verify against the last known-good keys
is far safer than rejecting every authenticated request. Keys are not secrets
and rotation is infrequent, so the exposure is small; a total authentication
outage is not. The 10-minute TTL still bounds how long a *revoked* key stays
usable under normal operation.

### A failed fetch is never cached

Failure leaves the previous key set in place. An empty or error response is
never stored, so one bad response cannot poison verification until the next TTL.

---

## 4. Context derivation

`resolve_principal_identity(p_external_object_id, p_external_directory_id)` —
a `SECURITY DEFINER` function (migrations `20260920180000`, `20260920190000`) —
is the single trusted resolution point. It
returns the user id, whether they are a platform admin, and their tenant
membership with role and tenant status.

It takes **a principal id and nothing else**. There is no parameter through
which a caller could nominate a tenant, so it cannot be used to obtain a context
for someone else's tenant however it is called. `search_path` is pinned and
`EXECUTE` is revoked from `PUBLIC`, for the reasons in
[tenant-isolation.md](tenant-isolation.md) §1.

Three outcomes, deliberately distinguished:

| Result | Meaning | Response |
|---|---|---|
| No row | Principal unknown to us | `403` |
| Row, no tenant | Known user, no membership | `403` |
| Row, tenant suspended | Access withdrawn | `403` |
| Row, active tenant | Member | `AuthenticatedTenantContext` |
| Row, platform admin | Operator | `PlatformAdminContext` |

Platform admin **takes precedence** over tenant membership: an operator who also
owns a shop acts as one or the other, never both at once, and that is decided
once here rather than at each call site.

Because the context comes from the database, changing the database changes it
while the token stays byte-identical — asserted by
`Invariant_membershipChangeInDatabase_changesContext`.

---

## 5. The three contexts are not interchangeable

| Context | Produced by | May do |
|---|---|---|
| `AuthenticatedTenantContext` | verified JWT → membership | Tenant operations, own tenant only, subject to role |
| `PlatformAdminContext` | verified JWT → `platform_admins` | Platform operations only |
| `PublicTenantContext` | validated public slug | Published public data only |

The separations that matter:

- **A platform admin is not a super-shopkeeper.** It holds *no* tenant
  capability — not even read. Letting an admin context satisfy a tenant check
  would make every tenant guard conditional on a role string, which is precisely
  the confusion that produces cross-tenant access.
- **A public context is not a weak shopkeeper.** It can never reach a tenant
  operation, so a public page cannot become a side door into the dashboard.
- **A shopkeeper is not an admin.** A valid shopkeeper token grants no platform
  capability whatsoever.

A matrix-completeness test asserts every capability is held by **exactly one**
context kind, and that an unknown capability string is denied by all three.

### Authorization matrix

| Capability | staff | manager | owner | admin | public |
|---|:--:|:--:|:--:|:--:|:--:|
| `tenant:read` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `tenant:pricing:read` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `tenant:realtime:subscribe` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `tenant:audit:read` | ✗ | ✓ | ✓ | ✗ | ✗ |
| `tenant:pricing:write` | ✗ | ✓ | ✓ | ✗ | ✗ |
| `tenant:branding:write` | ✗ | ✓ | ✓ | ✗ | ✗ |
| `tenant:pricing:delete` | ✗ | ✗ | ✓ | ✗ | ✗ |
| `tenant:link:rotate` | ✗ | ✗ | ✓ | ✗ | ✗ |
| `platform:*` | ✗ | ✗ | ✗ | ✓ | ✗ |
| `public:rates:read` | ✗ | ✗ | ✗ | ✗ | ✓ |
| `public:realtime:subscribe` | ✗ | ✗ | ✗ | ✗ | ✓ |

Destructive and identity-affecting operations (deleting a pricing rule,
rotating a public link) are owner-only.

---

## 6. Failure semantics

| Outcome | Status | Why |
|---|---|---|
| No token, malformed, expired, bad signature, wrong issuer/audience, unknown key | `401` | Not authenticated |
| Valid token, no membership / unknown user | `403` | Authenticated, not authorised |
| Valid token, tenant suspended | `403` | Authenticated, access withdrawn |
| Valid context, insufficient role | `403` | Authorised identity, wrong capability |
| Cross-tenant resource | `403` | Same as a nonexistent one — no existence oracle |
| Signing keys unreachable | `503` | Our fault, not the caller's |

**Authentication failures never become `500`.** An unrecognised verifier fault is
still reported as `401`, never as a server error a caller might retry with the
same token.

**`503` rather than `401` for a key-source outage** is deliberate: `401` would
tell every client to re-authenticate, which cannot help and would drive a login
stampede during an incident.

Every failure reason collapses to one of two client-visible messages —
"Authentication required" or "Authentication is temporarily unavailable".
Distinguishing "wrong issuer" from "bad signature" would tell an attacker which
part of a forged token to fix next. The precise reason goes to logs only.

---

## 7. Observability

`log_failure` records the failure category, request id, method, matched route
and timestamp.

**Never logged:** the raw JWT, the `Authorization` header, any claim contents,
secrets or private keys. A category plus a request id is enough to investigate;
the token is not, and logging it would place a live credential in the log store.

The matched route (`req.route.path`) is logged rather than the raw URL, because
a raw URL can carry identifiers.

`pino` redaction (`platform/logger.ts`) covers `req.headers.authorization`,
`*.token` and `*.access_token` as a second line of defence, so an object logged
wholesale elsewhere still cannot leak a token.

---

## 8. Production configuration

**Production refuses to boot** without `AUTH_ISSUER`, `AUTH_AUDIENCE` or
`AUTH_DIRECTORY_ID`. Each is independently sufficient to make verification
meaningless, so each is checked separately and the operator sees every missing
value at once.

Also rejected at startup:

- a mixed asymmetric/symmetric algorithm list, `none`, or an unknown algorithm;
- **an algorithm/key-source mismatch** — asymmetric algorithms with no JWKS, or
  a symmetric allowlist pointed at a JWKS (pointing HMAC verification at a
  published key set is an algorithm-confusion hazard);
- a clock tolerance above 120s;
- a JWKS cooldown at or above the cache TTL, which would stop rotation being
  picked up between refreshes.

### There is no development bypass

No configuration flag disables verification, and none exists to be left on by
accident. The verifier takes its key resolver as a **constructor dependency**;
tests inject a local JWKS built from generated keypairs. For local development,
point `AUTH_ISSUER` at your own Entra External ID tenant — a different issuer,
not a weaker code path.

---

## 9. Tests

| Case | Test |
|---|---|
| 1. Valid JWT | `Verify_validToken_producesVerifiedPrincipal` |
| 2. Expired | `Verify_expiredToken_isRejected` (+ tolerance boundaries) |
| 3. Invalid signature | `Verify_tokenSignedByUnknownKey_isRejected`, `Verify_tamperedPayload_isRejected` |
| 4. Wrong issuer | `Verify_wrongIssuer_isRejected`, `Verify_issuerPrefixOfExpected_isRejected` |
| 4b. Wrong directory | `Verify_tokenFromAnotherDirectory_isRejected` |
| 4c. Wrong client | `Verify_tokenFromAnUnlistedClient_isRejected` |
| 5. Wrong audience | `Verify_wrongAudience_isRejected` |
| 6. Unsupported algorithm | `Verify_hmacTokenAgainstAsymmetricVerifier_isRejected`, `Verify_algNone_isRejected` |
| 7. Missing subject | `Verify_tokenWithoutSubject_isRejected`, `Verify_nonUuidSubject_isRejected` |
| 8. Malformed token | 7 parameterised shapes |
| 9. Key rotation | `JwksCache_unknownKid_triggersRefreshAndAcceptsTheRotatedKey` |
| 10. Unknown kid | `JwksCache_floodOfForgedKids_isRateLimitedToOneFetch` |
| 11. A→B access | `AuthChain_tenantAToken_readsOnlyTenantARowsThroughEveryLayer` |
| 12. B in URL | `Invariant_tenantIdInUrlPath_doesNotChangeContext` |
| 13. B in body | `Invariant_tenantIdInRequestBody_doesNotChangeContext` |
| 14. B in query | `Invariant_tenantIdInQueryString_doesNotChangeContext` |
| 15. Forged header | `Invariant_forgedTenantHeaders_doNotChangeContext` |
| 16. No membership | `Derivation_userWithNoMembership_isRejected` |
| 17. Shopkeeper → admin | `Http_shopkeeperAttemptingPlatformAdminOperation_returns403` |
| 18. Public → authenticated | `PublicContext_cannotBeUsedForAnAuthenticatedOperation` |
| 19. Cross-tenant resource | `AuthChain_*` + service isolation suite |
| 20. Derivation failure | `Derivation_unknownPrincipal_isRejected` |
| **The invariant** | **`Invariant_everyCallerControlledTenantInput_isIgnored`** |

The regression test presents a token stuffed with tenant B claims **and** tenant
B in the path, query string, body and two custom headers — every caller-controlled
channel at once — and asserts the context is still tenant A.

```bash
npm test --workspace apps/api                  # verifier, JWKS, authorization
npx vitest run --config apps/api/vitest.integration.config.ts \
  apps/api/tests/integration/auth_chain.test.ts # the full chain
```
