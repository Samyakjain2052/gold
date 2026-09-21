# ADR-0006: Microsoft Entra External ID replaces Supabase for authentication

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Samyak Jain
- **Supersedes:** the Supabase auth decision in ARCHITECTURE.md §2 / ADR-0001

## Context

The architecture specified Supabase for authentication, following the team's
`authentication.md` §2 and §7. Every other component was already Azure —
PostgreSQL Flexible Server, Blob Storage, Container Apps, Key Vault.

Two facts changed the decision:

1. **No Supabase project exists, and none is available.** The `SUPABASE_*`
   values in `.env` were the placeholders from `.env.example`;
   `your-project.supabase.co` does not resolve. There was nothing to inspect and
   nothing to migrate.
2. **Azure access is available** — subscription `5246f9c8…`, directory
   `57e7a430…`, with `Microsoft.DBforPostgreSQL`, `Microsoft.App`,
   `Microsoft.Cache` and `Microsoft.KeyVault` already registered in
   `centralindia`, alongside several existing workloads.

Supabase was therefore the single non-Azure dependency in an otherwise
Azure-native design, and an unavailable one.

## Decision

**Microsoft Entra External ID** (CIAM) is the identity provider for shopkeeper
accounts.

- **External ID**, not workforce Entra ID. Jewellery shopkeepers are *customers*.
  Putting them in a workforce directory makes each one a directory user, which
  is the wrong licensing model and the wrong lifecycle — sign-up is admin-driven
  rather than self-service.
- The External ID tenant is **not created yet**, and no production issuer or
  audience has been invented. Production refuses to boot without them.
- `AUTH_JWT_ALGORITHMS` defaults to **RS256**, verified against the live
  discovery document rather than assumed.

## Resolved against the live tenant

Read from `https://login.microsoftonline.com/57e7a430…/v2.0/.well-known/openid-configuration`
and its JWKS:

| Property | Verified |
|---|---|
| Algorithm | **RS256 only** |
| JWKS | `…/discovery/v2.0/keys`, reachable |
| Key type | 6 keys, all `kty: RSA`, `use: sig` |
| Symmetric keys | **Zero `oct` keys** — no legacy HS256 |
| Rotation | Overlapping key set, selected by `kid` |
| Subject type | `pairwise` |

The HS256-versus-asymmetric question is therefore settled: asymmetric, RS256,
JWKS, no symmetric configuration anywhere. The all-asymmetric-or-all-symmetric
guard remains meaningful and is now joined by an algorithm/key-source mismatch
check.

## Consequences

**The verifier did not change.** It was built to take a key resolver plus
issuer/audience configuration and never named a vendor, so the swap touched
configuration, claim names and documentation — not verification logic. That is
the payoff for the vendor-neutral boundary built in Stage 5.

**Two new verification steps**, both mandated by Microsoft's guidance:

- **`tid` pinning.** Signature, issuer and audience alone do not pin a token to
  our directory: with a multi-tenant app registration, a token minted in any
  Entra tenant can carry the same audience and a genuine Microsoft signature.
  Microsoft names this the confused-deputy problem. `AUTH_DIRECTORY_ID` is
  required in production.
- **`azp` pinning.** Optional, but it stops a token issued to another
  application in the same directory being replayed against this API.

**The user key changed shape.** Entra issues **pairwise** subject identifiers:
`sub` is unique per (user, application) pair, so the same shopkeeper reaching us
through a second app registration — a mobile app, an admin portal — would
present a different `sub` and look like a new user. `users` is now keyed on
(`external_directory_id`, `external_object_id`) — Entra's `tid` + `oid`. `sub`
is retained on the principal for log correlation only.

Migration `20260920190000_entra_identity` renames the column and updates both
`SECURITY DEFINER` resolvers to take the pair.

**Negative.** An External ID tenant is a separate tenant from the workforce one,
so there are two directories to operate. Entra External ID is free to 50k
monthly active users but priced beyond that. Local development now needs an
Entra tenant rather than a local container — there is deliberately no bypass.

## Alternatives

**Workforce Entra ID (the existing tenant)** — fastest to wire up, and the
tenant already exists. Rejected: every shopkeeper would become a directory user,
which is the wrong licensing and lifecycle model for external customers.

**Self-issued JWTs signed by Azure Key Vault** — local accounts in PostgreSQL
with argon2id, our API as issuer, an HSM-held RSA key, our own published JWKS.
Genuinely attractive: no second tenant, no per-user cost, works offline. Rejected
because it means owning password reset, MFA, email delivery and breach response —
a large surface for a small team, and rolling your own authentication is the
thing most likely to go quietly wrong.

**Staying on Supabase** — not available, and it would leave one non-Azure
dependency in an otherwise Azure-native deployment.
