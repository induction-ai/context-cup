import { SiteNav } from "@/src/components/site_nav";
import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "Context Cup",
  description:
    "A competition to build the context engine that matches the baseline for less",
};

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
