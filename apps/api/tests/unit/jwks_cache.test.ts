/**
 * JWKS caching, rotation and failure behaviour.
 *
 * The fetcher is injected and the clock is manual, so refresh windows,
 * cooldowns and stale-grace boundaries are exercised deterministically — no
 * network, no sleeping.
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import { ManualClock } from "../../src/platform/clock.js";
import {
  create_http_jwks_fetcher,
  AuthenticationError,
  JwksCache,
  JwtVerifier,
  type JwksFetcher,
  type JwtVerifierOptions,
} from "../../src/modules/auth/index.js";

const URL = "https://project.supabase.co/auth/v1/.well-known/jwks.json";
const ISSUER = "https://project.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const SUBJECT = "6f1c2f3a-1111-4111-8111-1c2f3a6f1c2f";
const OBJECT_ID = "7a2d3e4b-2222-4222-8222-2d3e4b7a2d3e";
const DIRECTORY_ID = "0d1e2c70-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-20T12:00:00.000Z");

interface Keypair {
  readonly kid: string;
  readonly private_key: CryptoKey;
  readonly jwk: JWK;
}

let key_old: Keypair;
let key_new: Keypair;

async function make_keypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    kid,
    private_key: privateKey,
    jwk: { ...jwk, kid, alg: "ES256", use: "sig" },
  };
}

beforeAll(async () => {
  key_old = await make_keypair("key-old");
  key_new = await make_keypair("key-new");
});

const verifier_options: JwtVerifierOptions = {
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ["ES256"],
  expected_directory_id: DIRECTORY_ID,
  allowed_client_ids: [],
  clock_tolerance_s: 5,
  max_future_iat_s: 60,
  max_token_age_s: 0,
};

async function token_from(key: Keypair): Promise<string> {
  const now_s = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({ oid: OBJECT_ID, tid: DIRECTORY_ID })
    .setProtectedHeader({ alg: "ES256", kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(SUBJECT)
    .setIssuedAt(now_s)
    .setExpirationTime(now_s + 3600)
    .sign(key.private_key);
}

/** A fetcher whose response and failures the test controls. */
function controllable_fetcher(initial: readonly JWK[]) {
  const state = {
    keys: [...initial],
    calls: 0,
    fail: false,
    fail_message: "connection refused",
  };

  const fetcher: JwksFetcher = async () => {
    state.calls += 1;
    if (state.fail) throw new Error(state.fail_message);
    return { keys: [...state.keys] };
  };

  return { state, fetcher };
}

function setup(initial: readonly JWK[], options = {}) {
  const clock = new ManualClock(NOW);
  const { state, fetcher } = controllable_fetcher(initial);
  const cache = new JwksCache(URL, clock, fetcher, options);
  const verifier = new JwtVerifier(cache.key_resolver(), verifier_options, clock);
  return { clock, state, cache, verifier };
}

describe("caching", () => {
  test("JwksCache_firstVerification_fetchesOnce", async () => {
    const { state, verifier } = setup([key_old.jwk]);
    await verifier.verify(await token_from(key_old));
    expect(state.calls).toBe(1);
  });

  /** The reason the cache exists: no outbound call per request. */
  test("JwksCache_repeatedVerifications_doNotRefetch", async () => {
    const { state, verifier, cache } = setup([key_old.jwk]);
    const token = await token_from(key_old);

    for (let i = 0; i < 25; i += 1) await verifier.verify(token);

    expect(state.calls).toBe(1);
    expect(cache.stats().cache_hits).toBeGreaterThan(20);
  });

  test("JwksCache_afterTtl_refetches", async () => {
    const { clock, state, verifier } = setup([key_old.jwk], {
      cache_max_age_ms: 600_000,
    });
    const token = await token_from(key_old);

    await verifier.verify(token);
    expect(state.calls).toBe(1);

    clock.advance(600_001);
    await verifier.verify(token);
    expect(state.calls).toBe(2);
  });

  test("JwksCache_warm_populatesBeforeFirstRequest", async () => {
    const { state, cache } = setup([key_old.jwk]);
    await cache.warm();

    expect(state.calls).toBe(1);
    expect(cache.stats().cached_kids).toEqual(["key-old"]);
    expect(cache.stats().fetched_at).not.toBeNull();
  });

  /** Concurrent requests on a cold cache share one outbound fetch. */
  test("JwksCache_concurrentColdRequests_makeASingleFetch", async () => {
    const { state, verifier } = setup([key_old.jwk]);
    const token = await token_from(key_old);

    await Promise.all(Array.from({ length: 10 }, () => verifier.verify(token)));
    expect(state.calls).toBe(1);
  });
});

describe("key rotation", () => {
  test("JwksCache_unknownKid_triggersRefreshAndAcceptsTheRotatedKey", async () => {
    const { clock, state, verifier, cache } = setup([key_old.jwk], {
      cooldown_ms: 30_000,
    });

    await verifier.verify(await token_from(key_old));
    expect(state.calls).toBe(1);

    // The provider rotates; a token arrives signed by the new key.
    state.keys = [key_old.jwk, key_new.jwk];
    clock.advance(30_001); // past the cooldown

    const principal = await verifier.verify(await token_from(key_new));
    expect(principal.external_object_id).toBe(OBJECT_ID);
    expect(state.calls).toBe(2);
    expect(cache.stats().rotations_detected).toBeGreaterThanOrEqual(1);
  });

  test("JwksCache_retiredKey_stopsVerifyingAfterRefresh", async () => {
    const { clock, state, verifier } = setup([key_old.jwk], {
      cache_max_age_ms: 600_000,
    });
    await verifier.verify(await token_from(key_old));

    // Old key retired entirely.
    state.keys = [key_new.jwk];
    clock.advance(600_001);

    await expect(verifier.verify(await token_from(key_old))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    // The new key works on the same refreshed set.
    await expect(verifier.verify(await token_from(key_new))).resolves.toBeDefined();
  });

  /**
   * `kid` is attacker-controlled. Without a cooldown, a flood of tokens bearing
   * random kids would trigger one outbound fetch each — a denial-of-service
   * against the identity provider, and through it, against us.
   */
  test("JwksCache_floodOfForgedKids_isRateLimitedToOneFetch", async () => {
    const { state, verifier, cache } = setup([key_old.jwk], { cooldown_ms: 30_000 });
    await verifier.verify(await token_from(key_old));
    const baseline = state.calls;

    for (let i = 0; i < 50; i += 1) {
      const forged = await new SignJWT({ oid: OBJECT_ID, tid: DIRECTORY_ID })
        .setProtectedHeader({ alg: "ES256", kid: `forged-${i}` })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(SUBJECT)
        .setIssuedAt(Math.floor(NOW.getTime() / 1000))
        .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 3600)
        .sign(key_old.private_key);

      await expect(verifier.verify(forged)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    }

    // At most one refresh across fifty forged kids.
    expect(state.calls - baseline).toBeLessThanOrEqual(1);
    expect(cache.stats().cooldown_rejections).toBeGreaterThan(40);
  });

  test("JwksCache_unknownKidWithinCooldown_reportsUnknownKey", async () => {
    const { verifier } = setup([key_old.jwk], { cooldown_ms: 30_000 });
    await verifier.verify(await token_from(key_old));

    try {
      await verifier.verify(await token_from(key_new));
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as AuthenticationError).reason).toBe("unknown_key");
    }
  });
});

describe("failure behaviour", () => {
  /** An outage must not take authentication down with it. */
  test("JwksCache_fetchFailsWithinStaleGrace_servesCachedKeys", async () => {
    const { clock, state, verifier, cache } = setup([key_old.jwk], {
      cache_max_age_ms: 600_000,
      stale_grace_ms: 86_400_000,
    });
    const token = await token_from(key_old);
    await verifier.verify(token);

    state.fail = true;
    clock.advance(600_001); // TTL elapsed, refresh will fail

    const principal = await verifier.verify(token);
    expect(principal.external_object_id).toBe(OBJECT_ID);
    expect(cache.stats().stale_serves).toBeGreaterThan(0);
    expect(cache.stats().failures).toBeGreaterThan(0);
  });

  test("JwksCache_fetchFailsBeyondStaleGrace_failsClosed", async () => {
    const { clock, state, verifier } = setup([key_old.jwk], {
      cache_max_age_ms: 600_000,
      stale_grace_ms: 3_600_000,
    });
    const token = await token_from(key_old);
    await verifier.verify(token);

    state.fail = true;
    clock.advance(3_600_001);

    try {
      await verifier.verify(token);
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as AuthenticationError).reason).toBe("key_source_unavailable");
      // Our fault, not the caller's — surfaces as 503, not 401.
      expect((error as AuthenticationError).is_infrastructure_failure).toBe(true);
    }
  });

  test("JwksCache_fetchFailsOnColdCache_failsClosed", async () => {
    const { state, verifier } = setup([key_old.jwk]);
    state.fail = true;

    try {
      await verifier.verify(await token_from(key_old));
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as AuthenticationError).reason).toBe("key_source_unavailable");
    }
  });

  /** A failure must never overwrite good keys with nothing. */
  test("JwksCache_failedFetch_doesNotPoisonTheCache", async () => {
    const { clock, state, verifier, cache } = setup([key_old.jwk], {
      cache_max_age_ms: 600_000,
    });
    const token = await token_from(key_old);
    await verifier.verify(token);

    state.fail = true;
    clock.advance(600_001);
    await verifier.verify(token); // served stale

    expect(cache.stats().cached_kids).toEqual(["key-old"]);

    // Recovery replaces the set cleanly.
    state.fail = false;
    state.keys = [key_new.jwk];
    clock.advance(600_001);
    await expect(verifier.verify(await token_from(key_new))).resolves.toBeDefined();
    expect(cache.stats().cached_kids).toEqual(["key-new"]);
  });

  test("JwksCache_emptyKeySetResponse_isTreatedAsAFailure", async () => {
    const { state, verifier } = setup([]);
    state.keys = [];

    try {
      await verifier.verify(await token_from(key_old));
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as AuthenticationError).reason).toBe("key_source_unavailable");
    }
  });

  test("JwksCache_stats_areObservable", async () => {
    const { verifier, cache } = setup([key_old.jwk]);
    await verifier.verify(await token_from(key_old));

    const stats = cache.stats();
    expect(stats.fetches).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.cached_kids).toEqual(["key-old"]);
  });
});

/**
 * The real HTTP fetcher. `fetch` is stubbed rather than the fetcher itself, so
 * the response handling that runs in production is what gets exercised.
 */
describe("http jwks fetcher", () => {
  const original_fetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original_fetch;
  });

  function stub_fetch(impl: typeof globalThis.fetch): void {
    globalThis.fetch = impl;
  }

  test("HttpFetcher_validResponse_returnsKeys", async () => {
    stub_fetch(
      async () =>
        new Response(JSON.stringify({ keys: [key_old.jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const set = await create_http_jwks_fetcher(5_000)(URL);
    expect(set.keys).toHaveLength(1);
    expect(set.keys[0]?.kid).toBe("key-old");
  });

  test.each([401, 403, 404, 429, 500, 503])(
    "HttpFetcher_status_%s_throws",
    async (status: number) => {
      stub_fetch(async () => new Response("nope", { status }));
      await expect(create_http_jwks_fetcher(5_000)(URL)).rejects.toThrow(
        new RegExp(String(status)),
      );
    },
  );

  test("HttpFetcher_responseWithoutKeysArray_throws", async () => {
    stub_fetch(async () => new Response(JSON.stringify({ oops: true }), { status: 200 }));
    await expect(create_http_jwks_fetcher(5_000)(URL)).rejects.toThrow(
      /no `keys` array/,
    );
  });

  test("HttpFetcher_nonJsonBody_throws", async () => {
    stub_fetch(async () => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(create_http_jwks_fetcher(5_000)(URL)).rejects.toBeDefined();
  });

  test("HttpFetcher_nullBody_throws", async () => {
    stub_fetch(async () => new Response("null", { status: 200 }));
    await expect(create_http_jwks_fetcher(5_000)(URL)).rejects.toThrow(
      /no `keys` array/,
    );
  });

  /** A hanging endpoint must not hold the auth path open indefinitely. */
  test("HttpFetcher_hangingEndpoint_abortsAtTheTimeout", async () => {
    stub_fetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    await expect(create_http_jwks_fetcher(25)(URL)).rejects.toBeDefined();
  });

  test("HttpFetcher_requestsJson", async () => {
    let seen_accept: string | null = null;
    stub_fetch(async (_input, init) => {
      seen_accept =
        (init?.headers as Record<string, string> | undefined)?.["accept"] ?? null;
      return new Response(JSON.stringify({ keys: [key_old.jwk] }), { status: 200 });
    });

    await create_http_jwks_fetcher(5_000)(URL);
    expect(seen_accept).toBe("application/json");
  });
});
