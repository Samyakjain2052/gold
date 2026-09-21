"use client";

import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type Configuration,
} from "@azure/msal-browser";

/**
 * Entra External ID sign-in for the shopkeeper dashboard.
 *
 * ## Why MSAL rather than a hand-rolled flow
 *
 * The API verifies RS256 tokens against the tenant's JWKS, pins `tid` and
 * `azp`, and rejects anything else (Stage 5). The browser's job is therefore
 * only to obtain a genuine token, and the one library that Microsoft keeps in
 * step with that endpoint is MSAL. Hand-rolling PKCE here would add a second
 * implementation of the one thing that must not be subtly wrong.
 *
 * ## Token storage
 *
 * Tokens live in **session storage**, not local storage, and never in a cookie
 * or in application state we persist ourselves.
 *
 * - Not `localStorage`: a token there outlives the browser session and is
 *   readable by any script on the origin for days afterwards.
 * - Not a cookie: this is a Bearer API with no cookie auth, which is what lets
 *   the backend skip CSRF defences entirely (`app.ts` sets
 *   `credentials: false`). Introducing an auth cookie here would silently
 *   invalidate that reasoning.
 *
 * `storeAuthStateInCookie` is off for the same reason.
 *
 * Nothing in this module logs a token, an authorization header, or a claim.
 */

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new AuthConfigError(
      `${name} is not configured; the dashboard cannot sign anyone in`,
    );
  }
  return value;
}

export function auth_scopes(): string[] {
  return required("NEXT_PUBLIC_AUTH_SCOPES")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function msal_configuration(): Configuration {
  return {
    auth: {
      clientId: required("NEXT_PUBLIC_AUTH_CLIENT_ID"),
      authority: required("NEXT_PUBLIC_AUTH_AUTHORITY"),
      // External ID authorities are not under login.microsoftonline.com, so
      // MSAL must be told this host is legitimate or it refuses the authority.
      knownAuthorities: [new URL(required("NEXT_PUBLIC_AUTH_AUTHORITY")).hostname],
      // Derived from the running origin rather than configured, so a preview
      // deployment cannot send users back to production's callback. During
      // server rendering there is no origin; MSAL is browser-only and these
      // values are never used in that pass.
      ...(typeof window === "undefined"
        ? {}
        : {
            redirectUri: `${window.location.origin}/auth/callback`,
            postLogoutRedirectUri: window.location.origin,
          }),
      navigateToLoginRequestUrl: false,
    },
    cache: {
      cacheLocation: "sessionStorage",
      storeAuthStateInCookie: false,
    },
    system: {
      loggerOptions: {
        // MSAL's logger can emit tokens at Trace/Verbose. It is disabled
        // outright rather than filtered, so no future log-level change can
        // start writing authentication material to the console.
        loggerCallback: () => {},
        piiLoggingEnabled: false,
      },
    },
  };
}

let instance: PublicClientApplication | null = null;

/** The one MSAL instance for this tab. */
export async function get_msal(): Promise<PublicClientApplication> {
  if (instance !== null) return instance;

  const created = new PublicClientApplication(msal_configuration());
  await created.initialize();
  instance = created;
  return created;
}

/** Reset between tests. Not used by application code. */
export function __reset_msal_for_tests(): void {
  instance = null;
}

export function active_account(msal: PublicClientApplication): AccountInfo | null {
  return msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
}

/**
 * Get an access token for the API, refreshing silently where possible.
 *
 * Returns null when the user must interact again, rather than triggering a
 * redirect from deep inside a data fetch — the caller decides when it is
 * reasonable to throw the user out to the sign-in page.
 */
export async function acquire_token(msal: PublicClientApplication): Promise<string | null> {
  const account = active_account(msal);
  if (account === null) return null;

  try {
    const result = await msal.acquireTokenSilent({ scopes: auth_scopes(), account });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) return null;
    return null;
  }
}

export async function sign_in(msal: PublicClientApplication): Promise<void> {
  await msal.loginRedirect({ scopes: auth_scopes() });
}

/**
 * Sign out.
 *
 * Clears MSAL's cache *and* ends the session at Entra. A local-only clear
 * would leave the identity provider's session intact, so the next "sign in"
 * would silently restore the same user — which is not what anyone pressing
 * "sign out" on a shared showroom machine expects.
 */
export async function sign_out(msal: PublicClientApplication): Promise<void> {
  const account = active_account(msal);

  try {
    sessionStorage.clear();
  } catch {
    // Storage can be unavailable in private mode; the redirect below still
    // ends the server-side session, which is the part that matters.
  }

  await msal.logoutRedirect(account === null ? {} : { account });
}
