import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Live bullion rates",
    template: "%s · Live bullion rates",
  },
  description:
    "Current gold and silver rates published by your jeweller, updated live.",
  // The public page is a shop's own address; it should not accumulate search
  // presence under our domain, and the dashboard must never be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom left enabled deliberately: disabling it is a common and
  // needless accessibility failure on a page whose whole content is numbers.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f5" },
    { media: "(prefers-color-scheme: dark)", color: "#14110f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
