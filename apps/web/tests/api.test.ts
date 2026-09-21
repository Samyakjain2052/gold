/**
 * The API client.
 *
 * Two properties matter more than the rest: the access token is attached to
 * authenticated calls and to nothing else, and a failure never resolves to a
 * half-filled object that a page could render as a price.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ApiError,
  api_base_url,
  api_request,
  fetch_public_rates,
  fetch_public_shop,
  fetch_pricing_rules,
  fetch_session,
  public_stream_url,
  update_pricing_rule,
} from "@/lib/api";

const fetch_mock = vi.fn();

beforeEach(() => {
  fetch_mock.mockReset();
  vi.stubGlobal("fetch", fetch_mock);
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "fixed-key" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json_response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function last_call(): [string, RequestInit] {
  const call = fetch_mock.mock.calls.at(-1);
  if (call === undefined) throw new Error("fetch was not called");
  return call as [string, RequestInit];
}

function headers_of(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("base url", () => {
  test("ApiBaseUrl_trailingSlash_isStripped", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://api.test/");
    expect(api_base_url()).toBe("http://api.test");
    vi.unstubAllEnvs();
  });

  test("ApiBaseUrl_missing_throwsRatherThanCallingRelative", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    expect(() => api_base_url()).toThrow(/not configured/);
    vi.unstubAllEnvs();
  });
});

describe("public calls carry no credentials", () => {
  test("FetchPublicShop_sendsNoAuthorizationHeader", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: { slug: "s" } }));
    await fetch_public_shop("sharma-jewellers");

    const [url, init] = last_call();
    expect(url).toBe("http://api.test/api/v1/public/shops/sharma-jewellers");
    expect(headers_of(init)).not.toHaveProperty("Authorization");
  });

  test("FetchPublicRates_isNeverCached", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: [], meta: { count: 0 } }));
    await fetch_public_rates("sharma-jewellers");

    expect(last_call()[1].cache).toBe("no-store");
  });

  test("FetchPublicRates_returnsBothDataAndMeta", async () => {
    fetch_mock.mockResolvedValue(
      json_response({ data: [{ product_key: "GOLD_916" }], meta: { simulated: true } }),
    );

    const result = await fetch_public_rates("s");
    expect(result.rates).toHaveLength(1);
    expect(result.meta.simulated).toBe(true);
  });

  /** A hostile slug must not be able to climb out of the path. */
  test("PublicEndpoints_encodeTheSlug", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: {} }));
    await fetch_public_shop("../admin");

    expect(last_call()[0]).toBe("http://api.test/api/v1/public/shops/..%2Fadmin");
    expect(public_stream_url("../admin")).toContain("..%2Fadmin");
  });
});

describe("authenticated calls", () => {
  test("FetchSession_attachesTheBearerToken", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: { user: {}, tenant: {} } }));
    await fetch_session("token-abc");

    expect(headers_of(last_call()[1])["Authorization"]).toBe("Bearer token-abc");
  });

  test("FetchPricingRules_attachesTheToken", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: [] }));
    await fetch_pricing_rules("token-abc");

    expect(headers_of(last_call()[1])["Authorization"]).toBe("Bearer token-abc");
  });

  /** The version must travel as a precondition, or the API answers 428. */
  test("UpdatePricingRule_sendsIfMatchAndAnIdempotencyKey", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: { id: "r", version: 4 } }));

    await update_pricing_rule("token-abc", "rule-1", 3, {
      adjustment_kind: "absolute",
      adjustment_rupees_per_gram: "50.00",
      rounding_step_paise: 100,
      rounding_mode: "half_up",
      component_precision_paise: 1,
    });

    const [url, init] = last_call();
    const headers = headers_of(init);

    expect(init.method).toBe("PATCH");
    expect(url).toContain("/api/v1/pricing-rules/rule-1");
    expect(headers["If-Match"]).toBe("3");
    expect(headers["Idempotency-Key"]).toBe("fixed-key");
    expect(headers["Authorization"]).toBe("Bearer token-abc");
  });

  /** No tenant identifier is ever sent; the server derives it from the token. */
  test("UpdatePricingRule_bodyCarriesNoTenantOrIdentity", async () => {
    fetch_mock.mockResolvedValue(json_response({ data: {} }));

    await update_pricing_rule("t", "rule-1", 1, {
      adjustment_kind: "percentage",
      adjustment_bps: 250,
      rounding_step_paise: 100,
      rounding_mode: "half_up",
      component_precision_paise: 1,
    });

    const body = JSON.parse(String(last_call()[1].body)) as Record<string, unknown>;
    for (const forbidden of ["tenant_id", "user_id", "role", "version", "id"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe("failures never resolve", () => {
  test("ApiRequest_problemDocument_becomesATypedError", async () => {
    fetch_mock.mockResolvedValue(
      json_response(
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "Version mismatch",
          code: "CONFLICT",
          request_id: "req-1",
        },
        409,
      ),
    );

    const error = await api_request("/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).is_conflict).toBe(true);
    expect((error as ApiError).message).toBe("Version mismatch");
  });

  test("ApiRequest_nonJsonErrorBody_stillReportsTheStatus", async () => {
    fetch_mock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const error = (await api_request("/x").catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });

  test("ApiRequest_networkFailure_isStatusZero", async () => {
    fetch_mock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = (await api_request("/x").catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/could not reach/i);
  });

  test("ApiRequest_abort_reportsATimeout", async () => {
    fetch_mock.mockRejectedValue(new DOMException("aborted", "AbortError"));

    const error = (await api_request("/x").catch((e: unknown) => e)) as ApiError;
    expect(error.message).toMatch(/timed out/i);
  });

  test("ApiRequest_externalAbort_cancelsTheRequest", async () => {
    const controller = new AbortController();
    fetch_mock.mockImplementation((_url: string, init: RequestInit) => {
      controller.abort();
      return Promise.reject(
        init.signal?.aborted === true
          ? new DOMException("aborted", "AbortError")
          : new Error("signal not wired"),
      );
    });

    const error = (await api_request("/x", { signal: controller.signal }).catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(error.message).toMatch(/timed out/i);
  });
});
