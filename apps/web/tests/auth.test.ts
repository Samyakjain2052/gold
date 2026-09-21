/**
 * MSAL configuration.
 *
 * These are security assertions dressed as configuration tests. Where tokens
 * are stored, and whether an auth cookie exists, are decisions the rest of the
 * system depends on — the API skips CSRF defences precisely because this is a
 * Bearer client with no cookie — so a change to either should fail a test
 * rather than pass review unnoticed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthConfigError, auth_scopes, msal_configuration } from "@/lib/auth";

const AUTHORITY =
  "https://bullionshops.ciamlogin.com/f02e7b26-7b99-45ff-9696-d45c70cdb6c2/v2.0";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT_ID", "46ab7716-17fc-42c9-8a81-2667c2650c29");
  vi.stubEnv("NEXT_PUBLIC_AUTH_AUTHORITY", AUTHORITY);
  vi.stubEnv("NEXT_PUBLIC_AUTH_SCOPES", "api://bullion-rates/rates.access");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("token storage", () => {
  /**
   * `localStorage` would leave a token readable by any script on the origin for
   * days after the shopkeeper walked away from a showroom machine.
   */
  test("MsalConfig_storesTokensInSessionStorage_notLocalStorage", () => {
    expect(msal_configuration().cache?.cacheLocation).toBe("sessionStorage");
    expect(msal_configuration().cache?.cacheLocation).not.toBe("localStorage");
  });

  /**
   * An auth cookie would silently invalidate the backend's reasoning for
   * setting `credentials: false` and skipping CSRF protection entirely.
   */
  test("MsalConfig_storesNoAuthStateInCookies", () => {
    expect(msal_configuration().cache?.storeAuthStateInCookie).toBe(false);
  });

  /** MSAL can log tokens at verbose levels; the sink is disabled outright. */
  test("MsalConfig_loggerEmitsNothingAndDisablesPii", () => {
    const options = msal_configuration().system?.loggerOptions;

    expect(options?.piiLoggingEnabled).toBe(false);
    expect(() =>
      options?.loggerCallback?.(0, "a token would appear here", true),
    ).not.toThrow();
  });
});

describe("authority", () => {
  /** External ID is not under login.microsoftonline.com; MSAL needs telling. */
  test("MsalConfig_trustsTheExternalIdHost", () => {
    expect(msal_configuration().auth.knownAuthorities).toEqual([
      "bullionshops.ciamlogin.com",
    ]);
  });

  test("MsalConfig_usesTheConfiguredClientIdAndAuthority", () => {
    const config = msal_configuration();
    expect(config.auth.clientId).toBe("46ab7716-17fc-42c9-8a81-2667c2650c29");
    expect(config.auth.authority).toBe(AUTHORITY);
  });

  /**
   * The redirect URI is derived from the running origin, so a preview
   * deployment cannot send a user back to production's callback.
   */
  test("MsalConfig_redirectUri_followsTheRunningOrigin", () => {
    const config = msal_configuration();
    expect(config.auth.redirectUri).toBe(`${window.location.origin}/auth/callback`);
  });

  test("MsalConfig_neverNavigatesBackToTheLoginRequestUrl", () => {
    expect(msal_configuration().auth.navigateToLoginRequestUrl).toBe(false);
  });
});

describe("configuration failures are loud", () => {
  test.each(["NEXT_PUBLIC_AUTH_CLIENT_ID", "NEXT_PUBLIC_AUTH_AUTHORITY"])(
    "MsalConfig_missing_%s_throws",
    (name) => {
      vi.stubEnv(name, "");
      expect(() => msal_configuration()).toThrow(AuthConfigError);
    },
  );

  test("AuthScopes_missing_throwsRatherThanRequestingNone", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_SCOPES", "");
    expect(() => auth_scopes()).toThrow(AuthConfigError);
  });
});

describe("scopes", () => {
  test("AuthScopes_areSplitAndTrimmed", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_SCOPES", " a/b , c/d ");
    expect(auth_scopes()).toEqual(["a/b", "c/d"]);
  });

  test("AuthScopes_ignoreEmptyEntries", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_SCOPES", "a/b,,c/d,");
    expect(auth_scopes()).toEqual(["a/b", "c/d"]);
  });
});

// ---------------------------------------------------------------------------
// Token acquisition and sign-out
// ---------------------------------------------------------------------------

import { InteractionRequiredAuthError } from "@azure/msal-browser";
import type { AccountInfo, PublicClientApplication } from "@azure/msal-browser";
import { acquire_token, active_account, sign_in, sign_out } from "@/lib/auth";

const ACCOUNT = { homeAccountId: "a", username: "shopkeeper" } as AccountInfo;

function fake_msal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getActiveAccount: () => ACCOUNT,
    getAllAccounts: () => [ACCOUNT],
    acquireTokenSilent: vi.fn(async () => ({ accessToken: "token-abc" })),
    loginRedirect: vi.fn(async () => {}),
    logoutRedirect: vi.fn(async () => {}),
    ...overrides,
  } as unknown as PublicClientApplication;
}

describe("account resolution", () => {
  test("ActiveAccount_prefersTheActiveOne", () => {
    expect(active_account(fake_msal())).toBe(ACCOUNT);
  });

  test("ActiveAccount_fallsBackToTheFirstSignedIn", () => {
    const msal = fake_msal({ getActiveAccount: () => null });
    expect(active_account(msal)).toBe(ACCOUNT);
  });

  test("ActiveAccount_noneSignedIn_isNull", () => {
    const msal = fake_msal({ getActiveAccount: () => null, getAllAccounts: () => [] });
    expect(active_account(msal)).toBeNull();
  });
});

describe("acquire_token", () => {
  test("AcquireToken_silentSuccess_returnsTheAccessToken", async () => {
    await expect(acquire_token(fake_msal())).resolves.toBe("token-abc");
  });

  test("AcquireToken_noAccount_isNullWithoutCallingMsal", async () => {
    const acquireTokenSilent = vi.fn();
    const msal = fake_msal({
      getActiveAccount: () => null,
      getAllAccounts: () => [],
      acquireTokenSilent,
    });

    await expect(acquire_token(msal)).resolves.toBeNull();
    expect(acquireTokenSilent).not.toHaveBeenCalled();
  });

  /**
   * Returns null rather than redirecting from inside a data fetch: the caller
   * decides when it is reasonable to throw the user out to sign in again.
   */
  test("AcquireToken_interactionRequired_isNullNotARedirect", async () => {
    const msal = fake_msal({
      acquireTokenSilent: vi.fn(async () => {
        throw new InteractionRequiredAuthError("interaction_required");
      }),
    });

    await expect(acquire_token(msal)).resolves.toBeNull();
  });

  test("AcquireToken_unexpectedFailure_isNullNotAThrow", async () => {
    const msal = fake_msal({
      acquireTokenSilent: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    await expect(acquire_token(msal)).resolves.toBeNull();
  });
});

describe("sign in and out", () => {
  test("SignIn_requestsTheApiScopes", async () => {
    const msal = fake_msal();
    await sign_in(msal);

    expect(msal.loginRedirect).toHaveBeenCalledWith({
      scopes: ["api://bullion-rates/rates.access"],
    });
  });

  /**
   * Sign-out must clear local auth state *and* end the session at Entra. A
   * local-only clear would let the next sign-in silently restore the same user,
   * which is not what anyone pressing "sign out" on a shared machine expects.
   */
  test("SignOut_clearsSessionStorageAndEndsTheProviderSession", async () => {
    sessionStorage.setItem("msal.token", "should-not-survive");
    const msal = fake_msal();

    await sign_out(msal);

    expect(sessionStorage.getItem("msal.token")).toBeNull();
    expect(msal.logoutRedirect).toHaveBeenCalledWith({ account: ACCOUNT });
  });

  test("SignOut_withNoAccount_stillEndsTheProviderSession", async () => {
    const msal = fake_msal({ getActiveAccount: () => null, getAllAccounts: () => [] });
    await sign_out(msal);

    expect(msal.logoutRedirect).toHaveBeenCalledWith({});
  });

  /** Storage can throw in private mode; the redirect must still happen. */
  test("SignOut_whenStorageThrows_stillRedirects", async () => {
    const original = Storage.prototype.clear;
    Storage.prototype.clear = () => {
      throw new Error("denied");
    };

    const msal = fake_msal();
    await sign_out(msal);

    expect(msal.logoutRedirect).toHaveBeenCalled();
    Storage.prototype.clear = original;
  });
});
