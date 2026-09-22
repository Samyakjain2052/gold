/**
 * Stage 9 — the public page must never be cached across tenants.
 *
 * `/r/[slug]` is one route serving every shop. If Next.js were allowed to cache
 * it, a customer opening `/r/gupta-jewellers` could be served the response
 * rendered for `/r/sharma-jewellers` — the worst failure this system can have,
 * and one that no amount of backend RLS would catch, because the leak would
 * happen above the database.
 *
 * Three things prevent it, and each is asserted here rather than assumed:
 *
 *   1. the route segment opts out of caching entirely (`force-dynamic`);
 *   2. `revalidate = 0`, so no time-based route cache entry is created;
 *   3. the rates fetch is `no-store`, so the Data Cache holds nothing either.
 *
 * These are compile-time constants, so the test reads them directly. A refactor
 * that drops one is caught here rather than in production.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

describe("public page rendering mode", () => {
  test("SsrCaching_publicPage_isForcedDynamic", async () => {
    const page = (await import("@/app/r/[slug]/page")) as {
      dynamic?: string;
      revalidate?: number;
    };

    expect(page.dynamic).toBe("force-dynamic");
    expect(page.revalidate).toBe(0);
  });

  /**
   * `force-static` or a positive `revalidate` on this route would make one
   * shop's HTML reusable for another.
   */
  test("SsrCaching_publicPage_declaresNoStaticMode", () => {
    const text = source("src/app/r/[slug]/page.tsx");

    expect(text).not.toMatch(/dynamic\s*=\s*["']force-static["']/);
    expect(text).not.toMatch(/revalidate\s*=\s*[1-9]/);
    expect(text).not.toMatch(/generateStaticParams/);
  });

  test("SsrCaching_ratesFetch_isNoStore", () => {
    // The rates call hardcodes no-store in the client rather than accepting it
    // from a caller, so a page cannot opt back into caching them.
    expect(source("src/lib/api.ts")).toMatch(/cache:\s*["']no-store["']/);
  });

  /**
   * The shop document is fetched with no-store too. It changes rarely and the
   * API marks it cacheable for a shared cache keyed on the slug, but Next must
   * not hold its own copy across requests for different slugs.
   */
  test("SsrCaching_shopFetch_isNoStore", () => {
    const text = source("src/app/r/[slug]/page.tsx");
    expect(text).toMatch(/fetch_public_shop\(slug,\s*\{\s*cache:\s*["']no-store["']\s*\}\)/);
  });
});

describe("the slug is the only tenant selector", () => {
  /**
   * The page must derive everything from its own route parameter. A tenant id
   * read from a header, query string or cookie would be a client-supplied
   * tenant selector, which the whole architecture forbids.
   */
  test("SsrCaching_publicPage_readsNoTenantIdentifierFromTheRequest", () => {
    const text = source("src/app/r/[slug]/page.tsx");

    expect(text).not.toMatch(/tenant_id/);
    expect(text).not.toMatch(/searchParams/);
    expect(text).not.toMatch(/\bcookies\(\)/);
    expect(text).not.toMatch(/\bheaders\(\)/);
  });

  test("SsrCaching_apiClient_neverSendsATenantIdentifier", () => {
    const text = source("src/lib/api.ts");
    expect(text).not.toMatch(/tenant_id/);
    expect(text).not.toMatch(/X-Tenant/i);
  });
});
