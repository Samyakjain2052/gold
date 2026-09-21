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

  // The API is the only origin the browser talks to besides this one, and logo
  // blobs come from the storage account. Everything else is same-origin or
  // inline, so the default-src can stay closed.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default config;
