import { SiteNav } from "@/src/components/site_nav";
import { COLORS, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/src/lib/brand";
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Press_Start_2P } from "next/font/google";
import "./globals.scss";

// Bootstrap's font variables point at these (globals.scss).
const display = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--cc-font-display",
});
const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--cc-font-mono",
});

// The favicon, touch icon, and social card are app/icon.tsx,
// app/apple-icon.tsx, and app/opengraph-image.tsx; Next links them. The Open
// Graph and Twitter titles and descriptions follow each page's own.
export const metadata: Metadata = {
  metadataBase: SITE_URL,
  title: { default: SITE_NAME, template: `${SITE_NAME} - %s` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: COLORS.cream };

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${display.variable} ${mono.variable}`}
    >
      <body>
        <SiteNav />
        <main className="container-fluid px-3 py-4">{children}</main>
      </body>
    </html>
  );
}
