/**
 * Environment configuration, validated once at startup.
 *
 * `api-standards.md` §9: "Configuration must be validated at application startup.
 * Application must fail to start if required configuration is missing."
 *
 * A misconfigured deploy must fail loudly at boot, not silently at the first
 * customer page view.
 */
import { z } from "zod";
import {
  assert_valid_algorithms,
  ASYMMETRIC_ALGORITHMS,
} from "../modules/auth/jwt_verifier.js";

const MARKET_DATA_PROVIDERS = [
  "mock",
  "goldprice_dev",
  "metalprice_api",
  "ibja",
  "composite",
] as const;

export type MarketDataProviderName = (typeof MARKET_DATA_PROVIDERS)[number];

/** Providers requiring written licensing confirmation before production use. */
const PRODUCTION_BLOCKED_PROVIDERS: readonly MarketDataProviderName[] = [
  "goldprice_dev",
  "metalprice_api",
  "ibja",
  "composite",
];

const csv_list = z
  .string()
  .transform((raw) => raw.split(",").map((entry) => entry.trim()).filter(Boolean));

const env_schema = z.object({
  // --- Core ---------------------------------------------------------------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  SERVICE_NAME: z.string().min(1).default("bullion-api"),
  API_BASE_URL: z.url(),
  PUBLIC_WEB_URL: z.url(),
  ALLOWED_ORIGINS: csv_list,

  // --- Database -----------------------------------------------------------
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // --- Redis --------------------------------------------------------------
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().default("bullion:"),

  // --- Auth (Microsoft Entra External ID) ---------------------------------
  /**
   * Expected `iss`. Entra v2.0 issuers look like
   *   https://<subdomain>.ciamlogin.com/<directory-guid>/v2.0   (External ID)
   *   https://login.microsoftonline.com/<directory-guid>/v2.0    (workforce)
   * No default: an issuer must be the real one, never a guess.
   */
  AUTH_ISSUER: z.url().optional(),
  /** Expected `aud` — the API's Application ID URI or client id. */
  AUTH_AUDIENCE: z.string().min(1).optional(),
  /**
   * Expected `tid`. Pins tokens to our directory — without it a validly signed
   * token from any other Entra directory bearing our audience is accepted.
   */
  AUTH_DIRECTORY_ID: z.uuid().optional(),
  /** Explicit JWKS URL. Derived from AUTH_ISSUER when unset. */
  AUTH_JWKS_URL: z.url().optional(),
  /** Client app ids (`azp`) permitted to call this API. Empty = any in-directory. */
  AUTH_ALLOWED_CLIENT_IDS: csv_list.prefault(""),

  /**
   * Permitted signing algorithms. All-asymmetric or all-symmetric — mixing the
   * two enables algorithm confusion, and the verifier refuses such a list.
   * Entra publishes RS256 only (verified against the live discovery document).
   */
  AUTH_JWT_ALGORITHMS: csv_list.prefault("RS256"),
  /** Tolerated clock skew on exp/nbf. Small on purpose: it widens the window
   *  in which an expired token is still accepted. */
  AUTH_CLOCK_TOLERANCE_S: z.coerce.number().int().nonnegative().max(120).default(5),
  AUTH_MAX_FUTURE_IAT_S: z.coerce.number().int().nonnegative().max(600).default(60),
  /** 0 disables the absolute age cap; `exp` still applies. */
  AUTH_MAX_TOKEN_AGE_S: z.coerce.number().int().nonnegative().default(0),

  // JWKS cache — see modules/auth/jwks_cache.ts for why these values.
  AUTH_JWKS_CACHE_MAX_AGE_MS: z.coerce.number().int().positive().default(600_000),
  AUTH_JWKS_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  AUTH_JWKS_STALE_GRACE_MS: z.coerce.number().int().positive().default(86_400_000),
  AUTH_JWKS_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // --- Market data --------------------------------------------------------
  MARKET_DATA_PROVIDER: z.enum(MARKET_DATA_PROVIDERS).default("mock"),
  MARKET_DATA_API_KEY: z.string().optional(),
  MARKET_DATA_BASE_URL: z.url().optional(),
  // `.prefault` (not `.default`) so the value runs through the CSV transform.
  // `.default` would hand back the raw string and break every list consumer.
  MARKET_DATA_SYMBOLS: csv_list.prefault("XAU_INR,XAG_INR"),
  IBJA_API_KEY: z.string().optional(),
  IBJA_BASE_URL: z.url().optional(),
  MARKET_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MARKET_POLL_MARKET_HOURS_ONLY: z.stringbool().default(true),
  MARKET_HOURS_IST: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "expected HH:MM-HH:MM")
    .default("09:00-23:30"),
  MARKET_RATE_SANITY_MAX_MOVE_BPS: z.coerce.number().int().positive().default(500),

  /**
   * Escape hatch for using a licence-blocked provider in production.
   * Requires written confirmation on file — see docs/market-data-providers.md §3.1.
   */
  MARKET_DATA_LICENCE_CONFIRMED: z.stringbool().default(false),

  // --- Freshness ----------------------------------------------------------
  // Two thresholds, three states: fresh | stale | expired.
  // Defaults derive from the 60s poll interval — see market_data/freshness.ts.
  FRESHNESS_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  FRESHNESS_EXPIRED_AFTER_MS: z.coerce.number().int().positive().default(600_000),

  // --- Realtime -----------------------------------------------------------
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(20_000),
  SSE_MAX_CONNECTIONS_PER_REPLICA: z.coerce.number().int().positive().default(5_000),
  MARKET_POLLER_LEADER_LOCK_TTL_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_POLLER_ENABLED: z.stringbool().default(true),

  // --- Storage ------------------------------------------------------------
  AZURE_STORAGE_ACCOUNT_NAME: z.string().optional(),
  AZURE_STORAGE_CONTAINER_LOGOS: z.string().default("tenant-logos"),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  LOGO_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  LOGO_ALLOWED_TYPES: csv_list.prefault("image/png,image/jpeg,image/webp"),

  // --- Rate limiting ------------------------------------------------------
  RATE_LIMIT_PUBLIC_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().positive().default(10),

  // --- Observability ------------------------------------------------------
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

type RawConfig = z.infer<typeof env_schema>;

/**
 * Cross-field rules that a flat schema cannot express.
 *
 * Each returns a human-readable problem string, or null when satisfied.
 */
const cross_field_rules: ReadonlyArray<(c: RawConfig) => string | null> = [
  (c) =>
    c.MARKET_DATA_PROVIDER !== "mock" && !c.MARKET_DATA_API_KEY
      ? `MARKET_DATA_API_KEY is required when MARKET_DATA_PROVIDER="${c.MARKET_DATA_PROVIDER}"`
      : null,

  (c) =>
    (c.MARKET_DATA_PROVIDER === "ibja" || c.MARKET_DATA_PROVIDER === "composite") &&
    !c.IBJA_API_KEY
      ? `IBJA_API_KEY is required when MARKET_DATA_PROVIDER="${c.MARKET_DATA_PROVIDER}"`
      : null,

  // Licensing gate. See docs/market-data-providers.md §3.1 (blockers B1-B4).
  (c) =>
    c.NODE_ENV === "production" &&
    PRODUCTION_BLOCKED_PROVIDERS.includes(c.MARKET_DATA_PROVIDER) &&
    !c.MARKET_DATA_LICENCE_CONFIRMED
      ? `MARKET_DATA_PROVIDER="${c.MARKET_DATA_PROVIDER}" is not cleared for production. ` +
        "Written confirmation of customer-facing redistribution/display rights is required " +
        "(docs/market-data-providers.md §3.1). Set MARKET_DATA_LICENCE_CONFIRMED=true once filed."
      : null,

  (c) =>
    c.NODE_ENV === "production" && c.MARKET_DATA_PROVIDER === "mock"
      ? "MARKET_DATA_PROVIDER=mock must never run in production — it emits simulated prices"
      : null,

  (c) =>
    c.NODE_ENV === "production" && c.ALLOWED_ORIGINS.includes("*")
      ? 'ALLOWED_ORIGINS must not contain "*" in production'
      : null,

  (c) =>
    c.NODE_ENV === "production" && !/sslmode=require/.test(c.DATABASE_URL)
      ? "DATABASE_URL must include sslmode=require in production"
      : null,

  (c) =>
    c.NODE_ENV === "production" && !c.REDIS_URL.startsWith("rediss://")
      ? "REDIS_URL must use the rediss:// (TLS) scheme in production"
      : null,

  // Authentication must fail closed. Each of these is independently sufficient
  // to make verification meaningless, so each is checked separately and the
  // operator sees every missing value at once.
  (c) =>
    c.NODE_ENV === "production" && !c.AUTH_ISSUER
      ? "AUTH_ISSUER is required in production: tokens cannot be verified " +
        "without the expected issuer"
      : null,

  (c) =>
    c.NODE_ENV === "production" && !c.AUTH_AUDIENCE
      ? "AUTH_AUDIENCE is required in production: without it a token minted " +
        "for any other API would be accepted"
      : null,

  (c) =>
    c.NODE_ENV === "production" && !c.AUTH_DIRECTORY_ID
      ? "AUTH_DIRECTORY_ID is required in production: without pinning the " +
        "`tid` claim, a validly signed token from any other Entra directory " +
        "bearing our audience is accepted (confused-deputy)"
      : null,

  (c) =>
    c.NODE_ENV === "production" && !c.AUTH_ISSUER && !c.AUTH_JWKS_URL
      ? "AUTH_ISSUER or AUTH_JWKS_URL is required in production: " +
        "authentication cannot verify tokens without a signing key source"
      : null,

  // Algorithm/key-source coherence. An asymmetric allowlist needs a JWKS to
  // resolve public keys from; a symmetric one needs a shared secret and must
  // NOT be pointed at a JWKS. Catching the mismatch here means it surfaces at
  // deploy rather than as a blanket 401 in production.
  (c) => {
    const asymmetric = c.AUTH_JWT_ALGORITHMS.some((a) =>
      (ASYMMETRIC_ALGORITHMS as readonly string[]).includes(a),
    );
    const key_source = Boolean(c.AUTH_ISSUER || c.AUTH_JWKS_URL);

    if (asymmetric && c.NODE_ENV === "production" && !key_source) {
      return (
        `AUTH_JWT_ALGORITHMS is asymmetric (${c.AUTH_JWT_ALGORITHMS.join(", ")}) ` +
        "but no JWKS key source is configured; asymmetric verification needs " +
        "AUTH_ISSUER or AUTH_JWKS_URL"
      );
    }
    if (!asymmetric && c.AUTH_JWKS_URL) {
      return (
        "AUTH_JWT_ALGORITHMS is symmetric but AUTH_JWKS_URL is set; a symmetric " +
        "allowlist must use a shared secret, never a published key set — " +
        "pointing HMAC verification at a JWKS is an algorithm-confusion hazard"
      );
    }
    return null;
  },

  (c) => {
    try {
      assert_valid_algorithms(c.AUTH_JWT_ALGORITHMS);
      return null;
    } catch (error) {
      return `AUTH_JWT_ALGORITHMS is invalid: ${
        error instanceof Error ? error.message : "unknown problem"
      }`;
    }
  },

  (c) =>
    c.AUTH_JWKS_COOLDOWN_MS >= c.AUTH_JWKS_CACHE_MAX_AGE_MS
      ? "AUTH_JWKS_COOLDOWN_MS must be below AUTH_JWKS_CACHE_MAX_AGE_MS; " +
        "otherwise key rotation cannot be picked up between scheduled refreshes"
      : null,

  (c) =>
    c.FRESHNESS_STALE_AFTER_MS >= c.FRESHNESS_EXPIRED_AFTER_MS
      ? "FRESHNESS_STALE_AFTER_MS must be less than FRESHNESS_EXPIRED_AFTER_MS; " +
        "otherwise no quote is ever merely stale"
      : null,
];

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export interface AppConfig extends RawConfig {
  readonly is_production: boolean;
  readonly is_test: boolean;
  /** Derived from AUTH_ISSUER when not set explicitly. */
  readonly auth_jwks_url: string | undefined;
}

/**
 * Validate a raw environment record. Pure — takes the source explicitly so it
 * is testable without mutating `process.env`.
 *
 * @throws {ConfigError} listing every problem at once, not just the first.
 */
export function load_config(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // `.env` files carry optional keys with empty values (MARKET_DATA_API_KEY=).
  // An empty string is not `undefined`, so `.optional()` would reject it and a
  // fresh clone would fail to boot. Dropping blanks makes "" mean "unset",
  // while genuinely required keys still report as missing.
  const present: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );

  const parsed = env_schema.safeParse(present);

  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }

  const config = parsed.data;
  const problems = cross_field_rules
    .map((rule) => rule(config))
    .filter((problem): problem is string => problem !== null);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    ...config,
    is_production: config.NODE_ENV === "production",
    is_test: config.NODE_ENV === "test",
    // Entra publishes its key set alongside the v2.0 issuer:
    //   https://host/<directory>/v2.0  →  https://host/<directory>/discovery/v2.0/keys
    auth_jwks_url:
      config.AUTH_JWKS_URL ??
      (config.AUTH_ISSUER
        ? `${config.AUTH_ISSUER.replace(/\/v2\.0\/?$/, "")}/discovery/v2.0/keys`
        : undefined),
  };
}
