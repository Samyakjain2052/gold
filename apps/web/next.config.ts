import type { NextConfig } from "next";

/**
 * The shopkeeper dashboard is a client-rendered island behind MSAL, and the
 * public rate page is server-rendered per request so a customer's first paint
 * already carries the current rate rather than a spinner.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // `packages/contracts` ships TypeScript source rather than a build artefact,
  // so Next must compile it alongside the app.
  transpilePackages: ["@bullion/contracts"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: content_security_policy() },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Superseded by `frame-ancestors` in the CSP above, kept for the
          // browsers that still only honour this one.
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          // Only meaningful over HTTPS, which Static Web Apps and Container
          // Apps both terminate. Sent unconditionally because a browser
          // ignores it on a plaintext response, so localhost is unaffected.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

/**
 * Content Security Policy.
 *
 * Built from what the app actually does rather than copied from a template:
 *
 * - `connect-src` must include the API origin, because the browser both fetches
 *   from it and opens an `EventSource` against it, and the Entra authority,
 *   because MSAL talks to it directly.
 * - `img-src` allows the storage account over https, since tenant logos are
 *   served from blob storage, plus `data:` for inlined icons.
 * - `frame-ancestors 'none'` is the reason this header exists at all: the
 *   dashboard must not be embeddable, or a shopkeeper could be clickjacked into
 *   changing a rate.
 * - `form-action 'self'` — nothing here posts to a third party.
 *
 * `script-src` has to permit `'unsafe-inline'`: Next.js App Router emits inline
 * bootstrap and hydration scripts, and a nonce cannot be applied to a statically
 * rendered page. This is a documented limitation rather than an oversight — see
 * docs/production-readiness.md.
 */
function content_security_policy(): string {
  const api = origin_of(process.env["NEXT_PUBLIC_API_BASE_URL"]);
  const authority = origin_of(process.env["NEXT_PUBLIC_AUTH_AUTHORITY"]);
  const connect = ["'self'", api, authority].filter((s) => s !== null).join(" ");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `connect-src ${connect}`,
    "img-src 'self' data: https://*.blob.core.windows.net",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "font-src 'self'",
  ].join("; ");
}

/** The scheme+host of a configured URL, or null when it is absent or invalid. */
function origin_of(url: string | undefined): string | null {
  if (url === undefined || url === "") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export default config;
