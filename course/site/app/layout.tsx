import type { Metadata } from "next";
import Link from "next/link";
import "bootstrap/dist/css/bootstrap.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Context Cup",
  description:
    "Results of context-management drivers racing on shared benchmarks",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <nav className="navbar navbar-expand border-bottom px-3">
          <Link className="navbar-brand fw-semibold" href="/">
            Context Cup
          </Link>
          <div className="navbar-nav">
            <Link className="nav-link" href="/suites">
              Suites
            </Link>
          </div>
        </nav>
        <main className="container-fluid py-4">{children}</main>
      </body>
    </html>
  );
}
