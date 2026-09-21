import type { PublicShop } from "@bullion/contracts";
import styles from "./ShopHeader.module.css";

/**
 * The shop's identity at the top of its public page.
 *
 * Only fields the shopkeeper chose to publish reach this component — the API's
 * projection has already withheld a phone number or address whose `show_*` flag
 * is off, so there is no display toggle to get wrong here.
 *
 * The accent colour is applied as an inline custom property rather than a class,
 * because it is per-tenant data. It is constrained to a hex literal before use:
 * a colour value is injected into the style attribute, and an unvalidated one is
 * a place for a hostile string to end up in CSS.
 */
export function ShopHeader({ shop }: { shop: PublicShop }) {
  const accent = safe_accent(shop.accent_color);
  const contacts = [
    shop.contact.phone === null
      ? null
      : { label: "Call", value: shop.contact.phone, href: `tel:${shop.contact.phone}` },
    shop.contact.whatsapp === null
      ? null
      : {
          label: "WhatsApp",
          value: shop.contact.whatsapp,
          href: `https://wa.me/${shop.contact.whatsapp.replace(/[^\d]/g, "")}`,
        },
    shop.contact.email === null
      ? null
      : { label: "Email", value: shop.contact.email, href: `mailto:${shop.contact.email}` },
  ].filter((c): c is { label: string; value: string; href: string } => c !== null);

  const address = [shop.contact.address, shop.contact.city, shop.contact.state, shop.contact.pincode]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");

  return (
    <header
      className={styles.header}
      {...(accent === null ? {} : { style: { ["--shop-accent" as string]: accent } })}
    >
      <div className={styles.identity}>
        {shop.logo_url === null ? null : (
          // Plain <img>: the logo is on a third-party storage origin and is
          // already sized for display, so next/image would add a proxy hop for
          // no benefit. Empty alt because the shop name is right beside it.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.logo} src={shop.logo_url} alt="" width={56} height={56} />
        )}

        <div className={styles.names}>
          <h1 className={styles.name}>{shop.display_name}</h1>
          {shop.tagline === null ? null : (
            <p className={styles.tagline}>{shop.tagline}</p>
          )}
        </div>
      </div>

      {contacts.length > 0 || address !== "" ? (
        <div className={styles.contact}>
          {contacts.length > 0 ? (
            <ul className={styles.links}>
              {contacts.map((contact) => (
                <li key={contact.label}>
                  <a className={styles.link} href={contact.href}>
                    <span className={styles.linkLabel}>{contact.label}</span>
                    <span className={styles.linkValue}>{contact.value}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {address === "" ? null : <address className={styles.address}>{address}</address>}
        </div>
      ) : null}
    </header>
  );
}

/**
 * Accept only a plain hex colour.
 *
 * Anything else — a `url()`, a CSS variable, a semicolon — is dropped and the
 * default accent is used. The shop simply loses its colour, which is a far
 * better outcome than letting tenant-controlled text into a style attribute.
 */
export function safe_accent(value: string | null): string | null {
  if (value === null) return null;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : null;
}
