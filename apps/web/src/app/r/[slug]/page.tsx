import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { PublicRate, PublicShop, RatesMeta } from "@bullion/contracts";
import { ApiError, fetch_public_rates, fetch_public_shop, public_stream_url } from "@/lib/api";
import { LiveRates } from "@/components/LiveRates";
import { SimulatedBanner } from "@/components/SimulatedBanner";
import { ShopHeader } from "@/components/ShopHeader";
import { Ticker, default_notices } from "@/components/Ticker";
import { ShopActions } from "@/components/ShopActions";
import { LinkReplaced } from "@/components/LinkReplaced";
import styles from "./page.module.css";

/**
 * The public customer page: `/r/{slug}`.
 *
 * Addressed by the shop's slug, never by a tenant UUID — the identifier a
 * customer sees is the one the shopkeeper can rotate, and rotating it is how a
 * shop revokes a link that has spread too far.
 *
 * Rendered on the server per request so the first paint carries a real rate,
 * then upgraded to live updates by a small client island. No authentication is
 * required or offered; this page never asks a customer to sign in.
 */

// Rates must never be served from a build-time or route cache: this page's
// entire purpose is to be current.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ slug: string }>;
}

/** Distinguishes "no such shop" from "this link was replaced". */
type ShopLoad =
  | { kind: "ok"; shop: PublicShop; rates: PublicRate[]; meta: RatesMeta }
  | { kind: "gone" }
  | { kind: "missing" }
  | { kind: "unavailable" };

async function load(slug: string): Promise<ShopLoad> {
  try {
    // Both in flight together: the page needs each, and serialising them would
    // add a round trip to the slowest part of a mobile page load.
    const [shop, rates] = await Promise.all([
      fetch_public_shop(slug, { cache: "no-store" }),
      fetch_public_rates(slug),
    ]);

    return { kind: "ok", shop, rates: rates.rates, meta: rates.meta };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 410) return { kind: "gone" };
      if (error.status === 404) return { kind: "missing" };
    }
    // A backend outage is not a missing shop, and saying "not found" would
    // send a customer looking for a link that is perfectly valid.
    return { kind: "unavailable" };
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;

  try {
    const shop = await fetch_public_shop(slug, { cache: "no-store" });
    return {
      title: `${shop.display_name} · Today's rates`,
      description:
        shop.tagline ?? `Current gold and silver rates published by ${shop.display_name}.`,
    };
  } catch {
    // Metadata must never be the thing that breaks the page.
    return { title: "Today's rates" };
  }
}

export default async function ShopPage({ params }: PageProps) {
  const { slug } = await params;
  const result = await load(slug);

  if (result.kind === "missing") notFound();

  if (result.kind === "gone") {
    return (
      <main className={styles.page} id="main">
        <LinkReplaced />
      </main>
    );
  }

  if (result.kind === "unavailable") {
    return (
      <main className={styles.page} id="main">
        <div className={styles.unavailable} role="alert">
          <h1 className={styles.unavailableTitle}>Rates are temporarily unavailable</h1>
          <p className={styles.unavailableBody}>
            We could not reach the rate service. This is a problem on our side,
            not with the shop&rsquo;s link. Please try again in a moment.
          </p>
        </div>
      </main>
    );
  }

  const { shop, rates, meta } = result;

  return (
    <main className={styles.page} id="main">
      <div className={styles.container}>
        <SimulatedBanner simulated={meta.simulated} />

        <ShopHeader shop={shop} />

        <Ticker messages={default_notices(shop.display_name)} />

        <section aria-labelledby="rates-heading" className={styles.rates}>
          <h2 className={styles.ratesHeading} id="rates-heading">
            Today&rsquo;s rates
          </h2>

          <LiveRates initial_rates={rates} stream_url={public_stream_url(slug)} />
        </section>

        <footer className={styles.footer}>
          <p>
            Rates are published by {shop.display_name} and are indicative.
            Making charges, wastage and GST are additional where applicable.
          </p>
        </footer>
      </div>

      <ShopActions shop={shop} />
    </main>
  );
}
