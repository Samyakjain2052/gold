import { describe, expect, test } from "vitest";
import { load_config, ConfigError } from "../../src/platform/config.js";

/** A minimal environment that validates cleanly in development. */
function dev_env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    API_BASE_URL: "http://localhost:8080",
    PUBLIC_WEB_URL: "http://localhost:3000",
    ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgresql://bullion_app:devpassword@localhost:5432/bullion",
    REDIS_URL: "redis://localhost:6379",
    MARKET_DATA_PROVIDER: "mock",
    ...overrides,
  };
}

/** A production environment with every production-only rule satisfied. */
function prod_env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    API_BASE_URL: "https://api.example.com",
    PUBLIC_WEB_URL: "https://app.example.com",
    ALLOWED_ORIGINS: "https://app.example.com",
    DATABASE_URL: "postgresql://bullion_app:pw@db.example.com:5432/bullion?sslmode=require",
    REDIS_URL: "rediss://cache.example.com:6380",
    AUTH_ISSUER: "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0",
    AUTH_AUDIENCE: "api://bullion-rates",
    AUTH_DIRECTORY_ID: "0d1e2c70-0000-4000-8000-000000000001",
    MARKET_DATA_PROVIDER: "goldprice_dev",
    MARKET_DATA_API_KEY: "provider-key",
    MARKET_DATA_LICENCE_CONFIRMED: "true",
    ...overrides,
  };
}

describe("development defaults", () => {
  test("LoadConfig_minimalDevEnvironment_loadsWithDefaults", () => {
    const config = load_config(dev_env());
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(8080);
    expect(config.MARKET_DATA_PROVIDER).toBe("mock");
    expect(config.is_production).toBe(false);
  });

  /** The whole point of the mock provider: no account, no key, no cost. */
  test("LoadConfig_mockProvider_requiresNoApiKey", () => {
    expect(() => load_config(dev_env({ MARKET_DATA_PROVIDER: "mock" }))).not.toThrow();
  });

  test("LoadConfig_commaSeparatedOrigins_parsesToTrimmedList", () => {
    const config = load_config(
      dev_env({ ALLOWED_ORIGINS: "http://a.test, http://b.test ,," }),
    );
    expect(config.ALLOWED_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
  });

  test("LoadConfig_defaultSymbols_coverGoldAndSilver", () => {
    expect(load_config(dev_env()).MARKET_DATA_SYMBOLS).toEqual([
      "XAU_INR",
      "XAG_INR",
    ]);
  });

  /**
   * `.env` files list optional keys with empty values. Treating "" as unset is
   * what lets a fresh `cp .env.example .env` boot without editing.
   */
  test("LoadConfig_emptyOptionalValues_areTreatedAsUnset", () => {
    expect(() =>
      load_config(
        dev_env({
          MARKET_DATA_API_KEY: "",
          MARKET_DATA_BASE_URL: "",
          IBJA_BASE_URL: "",
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
          AZURE_STORAGE_CONNECTION_STRING: "",
        }),
      ),
    ).not.toThrow();
  });

  test("LoadConfig_emptyRequiredValue_stillReportsMissing", () => {
    expect(() => load_config(dev_env({ DATABASE_URL: "" }))).toThrow(ConfigError);
  });

  test("LoadConfig_jwksUrl_derivedFromEntraIssuer", () => {
    const config = load_config(dev_env({ AUTH_ISSUER: "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0" }));
    expect(config.auth_jwks_url).toBe(
      "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/discovery/v2.0/keys",
    );
  });
});

describe("fail-fast on invalid configuration", () => {
  test("LoadConfig_missingRequiredVariable_throwsConfigError", () => {
    const env = dev_env();
    delete env["DATABASE_URL"];
    expect(() => load_config(env)).toThrow(ConfigError);
  });

  /** Operators should see every problem at once, not fix them one deploy at a time. */
  test("LoadConfig_multipleProblems_reportsAllOfThem", () => {
    const env = dev_env();
    delete env["DATABASE_URL"];
    delete env["REDIS_URL"];

    try {
      load_config(env);
      expect.unreachable("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(2);
      expect(problems.join("\n")).toContain("DATABASE_URL");
      expect(problems.join("\n")).toContain("REDIS_URL");
    }
  });

  test("LoadConfig_malformedUrl_throwsConfigError", () => {
    expect(() => load_config(dev_env({ API_BASE_URL: "not-a-url" }))).toThrow(
      ConfigError,
    );
  });

  test("LoadConfig_unknownProvider_throwsConfigError", () => {
    expect(() =>
      load_config(dev_env({ MARKET_DATA_PROVIDER: "some_random_api" })),
    ).toThrow(ConfigError);
  });

  test("LoadConfig_nonMockProviderWithoutApiKey_throwsConfigError", () => {
    expect(() =>
      load_config(dev_env({ MARKET_DATA_PROVIDER: "goldprice_dev" })),
    ).toThrow(/MARKET_DATA_API_KEY is required/);
  });

  test("LoadConfig_ibjaProviderWithoutIbjaKey_throwsConfigError", () => {
    expect(() =>
      load_config(
        dev_env({
          MARKET_DATA_PROVIDER: "ibja",
          MARKET_DATA_API_KEY: "spot-key",
        }),
      ),
    ).toThrow(/IBJA_API_KEY is required/);
  });

  test("LoadConfig_freshnessThresholdsOutOfOrder_throwsConfigError", () => {
    expect(() =>
      load_config(
        dev_env({
          FRESHNESS_STALE_AFTER_MS: "600000",
          FRESHNESS_EXPIRED_AFTER_MS: "120000",
        }),
      ),
    ).toThrow(/FRESHNESS_STALE_AFTER_MS must be less than/);
  });

  test("LoadConfig_equalFreshnessThresholds_throwsConfigError", () => {
    expect(() =>
      load_config(
        dev_env({
          FRESHNESS_STALE_AFTER_MS: "120000",
          FRESHNESS_EXPIRED_AFTER_MS: "120000",
        }),
      ),
    ).toThrow(/must be less than/);
  });
});

describe("market-data licensing gate", () => {
  /**
   * Blockers B1–B4 in docs/market-data-providers.md. No paid provider is
   * cleared for customer-facing redistribution yet, so production boot is
   * refused until written confirmation is on file.
   */
  test("LoadConfig_blockedProviderInProductionWithoutConfirmation_refusesToBoot", () => {
    for (const provider of ["goldprice_dev", "metalprice_api", "ibja", "composite"]) {
      const env = prod_env({
        MARKET_DATA_PROVIDER: provider,
        IBJA_API_KEY: "ibja-key",
      });
      delete env["MARKET_DATA_LICENCE_CONFIRMED"];

      expect(() => load_config(env)).toThrow(/not cleared for production/);
    }
  });

  test("LoadConfig_blockedProviderWithConfirmation_boots", () => {
    expect(() => load_config(prod_env())).not.toThrow();
  });

  /** Simulated prices must never reach a real customer. */
  test("LoadConfig_mockProviderInProduction_refusesToBoot", () => {
    const env = prod_env({ MARKET_DATA_PROVIDER: "mock" });
    delete env["MARKET_DATA_API_KEY"];
    expect(() => load_config(env)).toThrow(/must never run in production/);
  });

  test("LoadConfig_blockedProviderInDevelopment_isAllowed", () => {
    expect(() =>
      load_config(
        dev_env({
          MARKET_DATA_PROVIDER: "metalprice_api",
          MARKET_DATA_API_KEY: "trial-key",
        }),
      ),
    ).not.toThrow();
  });
});

describe("authentication configuration fails closed", () => {
  /**
   * Without a key source there is no way to verify a token. Booting anyway
   * would leave the service either rejecting everything, or — far worse, if
   * anyone ever added a fallback — accepting it.
   */
  test("LoadConfig_productionWithoutIssuer_refusesToBoot", () => {
    const env = prod_env();
    delete env["AUTH_ISSUER"];
    expect(() => load_config(env)).toThrow(/AUTH_ISSUER is required/);
  });

  test("LoadConfig_productionWithoutAudience_refusesToBoot", () => {
    const env = prod_env();
    delete env["AUTH_AUDIENCE"];
    expect(() => load_config(env)).toThrow(/AUTH_AUDIENCE is required/);
  });

  /**
   * Without `tid` pinning, a validly signed token from ANY other Entra
   * directory carrying our audience is accepted — Microsoft's confused-deputy
   * problem. Production must not start without it.
   */
  test("LoadConfig_productionWithoutDirectoryId_refusesToBoot", () => {
    const env = prod_env();
    delete env["AUTH_DIRECTORY_ID"];
    expect(() => load_config(env)).toThrow(/confused-deputy/);
  });

  test("LoadConfig_productionWithExplicitJwksUrl_boots", () => {
    const env = prod_env({
      AUTH_JWKS_URL: "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/discovery/v2.0/keys",
    });
    expect(() => load_config(env)).not.toThrow();
  });

  /**
   * Algorithm/key-source mismatch. An asymmetric allowlist needs a JWKS;
   * a symmetric one must never be pointed at one.
   */
  test("LoadConfig_asymmetricAlgorithmsWithoutKeySource_refusesToBoot", () => {
    const env = prod_env();
    delete env["AUTH_ISSUER"];
    delete env["AUTH_JWKS_URL"];
    expect(() => load_config(env)).toThrow(/AUTH_ISSUER is required|JWKS key source/);
  });

  test("LoadConfig_symmetricAlgorithmsWithJwksUrl_refusesToBoot", () => {
    expect(() =>
      load_config(
        dev_env({
          AUTH_JWT_ALGORITHMS: "HS256",
          AUTH_JWKS_URL: "https://example.test/keys",
        }),
      ),
    ).toThrow(/symmetric allowlist must use a shared secret/);
  });

  test("LoadConfig_symmetricAlgorithmsWithoutJwksUrl_isAccepted", () => {
    expect(() =>
      load_config(dev_env({ AUTH_JWT_ALGORITHMS: "HS256" })),
    ).not.toThrow();
  });

  /** Permitting asymmetric and symmetric together enables algorithm confusion. */
  test("LoadConfig_mixedAlgorithms_refusesToBoot", () => {
    expect(() => load_config(dev_env({ AUTH_JWT_ALGORITHMS: "ES256,HS256" }))).toThrow(
      /algorithm-confusion/,
    );
  });

  test("LoadConfig_algorithmNone_refusesToBoot", () => {
    expect(() => load_config(dev_env({ AUTH_JWT_ALGORITHMS: "none" }))).toThrow(
      /unsigned tokens/,
    );
  });

  test("LoadConfig_unknownAlgorithm_refusesToBoot", () => {
    expect(() => load_config(dev_env({ AUTH_JWT_ALGORITHMS: "ES256,MAGIC" }))).toThrow(
      /not supported/,
    );
  });

  test.each([["ES256,RS256"], ["HS256,HS512"], ["EdDSA"]])(
    "LoadConfig_consistentAlgorithmSet_%s_isAccepted",
    (algorithms: string) => {
      expect(() =>
        load_config(dev_env({ AUTH_JWT_ALGORITHMS: algorithms })),
      ).not.toThrow();
    },
  );

  /** Verified against the live Entra discovery document: RS256 only. */
  test("LoadConfig_defaultAlgorithm_isRs256ToMatchEntra", () => {
    expect(load_config(dev_env()).AUTH_JWT_ALGORITHMS).toEqual(["RS256"]);
  });

  /** A cooldown at or above the TTL would stop rotation being picked up. */
  test("LoadConfig_jwksCooldownAtOrAboveTtl_refusesToBoot", () => {
    expect(() =>
      load_config(
        dev_env({
          AUTH_JWKS_COOLDOWN_MS: "600000",
          AUTH_JWKS_CACHE_MAX_AGE_MS: "600000",
        }),
      ),
    ).toThrow(/key rotation cannot be picked up/);
  });

  test("LoadConfig_clockToleranceBeyondCap_refusesToBoot", () => {
    // A large tolerance silently extends the life of expired tokens.
    expect(() => load_config(dev_env({ AUTH_CLOCK_TOLERANCE_S: "3600" }))).toThrow(
      ConfigError,
    );
  });

  test("LoadConfig_authDefaults_areSane", () => {
    const config = load_config(dev_env());
    expect(config.AUTH_CLOCK_TOLERANCE_S).toBe(5);
    expect(config.AUTH_MAX_FUTURE_IAT_S).toBe(60);
    expect(config.AUTH_JWKS_CACHE_MAX_AGE_MS).toBe(600_000);
    expect(config.AUTH_JWKS_COOLDOWN_MS).toBe(30_000);
    expect(config.AUTH_JWKS_STALE_GRACE_MS).toBe(86_400_000);
  });
});

describe("production hardening rules", () => {
  test("LoadConfig_wildcardCorsInProduction_refusesToBoot", () => {
    expect(() => load_config(prod_env({ ALLOWED_ORIGINS: "*" }))).toThrow(
      /ALLOWED_ORIGINS must not contain/,
    );
  });

  test("LoadConfig_databaseWithoutSslInProduction_refusesToBoot", () => {
    expect(() =>
      load_config(
        prod_env({ DATABASE_URL: "postgresql://u:p@db.example.com:5432/bullion" }),
      ),
    ).toThrow(/sslmode=require/);
  });

  test("LoadConfig_redisWithoutTlsInProduction_refusesToBoot", () => {
    expect(() =>
      load_config(prod_env({ REDIS_URL: "redis://cache.example.com:6379" })),
    ).toThrow(/rediss:\/\//);
  });

  test("LoadConfig_wildcardCorsInDevelopment_isAllowed", () => {
    expect(() => load_config(dev_env({ ALLOWED_ORIGINS: "*" }))).not.toThrow();
  });

  test("LoadConfig_validProductionEnvironment_setsIsProduction", () => {
    expect(load_config(prod_env()).is_production).toBe(true);
  });
});

describe("coercion", () => {
  test("LoadConfig_numericStrings_coerceToNumbers", () => {
    const config = load_config(dev_env({ PORT: "9000", LOGO_MAX_BYTES: "1048576" }));
    expect(config.PORT).toBe(9000);
    expect(config.LOGO_MAX_BYTES).toBe(1_048_576);
  });

  test("LoadConfig_booleanStrings_coerceToBooleans", () => {
    expect(load_config(dev_env({ MARKET_POLLER_ENABLED: "false" })).MARKET_POLLER_ENABLED).toBe(false);
    expect(load_config(dev_env({ MARKET_POLLER_ENABLED: "true" })).MARKET_POLLER_ENABLED).toBe(true);
  });

  test("LoadConfig_outOfRangePort_throwsConfigError", () => {
    expect(() => load_config(dev_env({ PORT: "70000" }))).toThrow(ConfigError);
  });

  test("LoadConfig_malformedMarketHours_throwsConfigError", () => {
    expect(() => load_config(dev_env({ MARKET_HOURS_IST: "9am-11pm" }))).toThrow(
      ConfigError,
    );
  });
});
