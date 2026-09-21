export {
  AuthenticationError,
  to_client_message,
  type AuthFailureReason,
  type VerifiedPrincipal,
} from "./principal.js";

export {
  assert_valid_algorithms,
  extract_bearer_token,
  JwtVerifier,
  JwtVerifierConfigError,
  ASYMMETRIC_ALGORITHMS,
  SYMMETRIC_ALGORITHMS,
  DEFAULT_VERIFIER_OPTIONS,
  type JwtVerifierOptions,
  type SupportedAlgorithm,
} from "./jwt_verifier.js";

export {
  create_http_jwks_fetcher,
  JwksCache,
  DEFAULT_JWKS_CACHE_OPTIONS,
  type JwksCacheOptions,
  type JwksCacheStats,
  type JwksFetcher,
  type JwksSet,
} from "./jwks_cache.js";

export {
  can,
  require_capability,
  require_platform_admin,
  require_tenant_actor,
  AuthorizationError,
  ALL_CAPABILITIES,
  type Capability,
} from "./authorization.js";
