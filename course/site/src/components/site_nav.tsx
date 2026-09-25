"use client";

import { DOCS } from "@/src/lib/links";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PixelIcon } from "./pixel_icon";

const PAGES = [
  { href: "/", label: "Home" },
  { href: "/leaderboard", label: "Leaderboard" },
];

/** The site bar: the wordmark, the pages (the current one underlined), and
 *  the way in. Below lg (where the home page drops its hero art) the pages
 *  and the button fold behind a menu toggle; Bootstrap's collapse, opened
 *  by state here since the site ships no Bootstrap JS. */
export function SiteNav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const current = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);
  return (
    <nav className="navbar navbar-expand-lg bg-body-tertiary border m-3 mb-0 px-3 py-2">
      <Link
        className="navbar-brand d-flex align-items-center gap-2 fs-4 me-4"
        href="/"
        onClick={close}
      >
        <PixelIcon name="flag" size={34} />
        <span>
          Context<span className="text-primary">Cup</span>
        </span>
      </Link>
      <button
        type="button"
        className="navbar-toggler"
        aria-controls="site-nav"
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen(!open)}
      >
        <PixelIcon
          name={open ? "close" : "menu"}
          size={24}
          className="d-block"
        />
      </button>
      <div
        id="site-nav"
        className={`collapse navbar-collapse${open ? " show" : ""}`}
      >
        <div className="navbar-nav me-auto">
          {PAGES.map(({ href, label }) => (
            <Link
              key={href}
              className={`nav-link${current(href) ? " active" : ""}`}
              aria-current={current(href) ? "page" : undefined}
              href={href}
              onClick={close}
            >
              {label}
            </Link>
          ))}
          <a className="nav-link" href={DOCS.drivers}>
            Docs
          </a>
        </div>
        <a className="btn btn-primary my-2 my-lg-0" href={DOCS.entering}>
          Enter the cup
        </a>
      </div>
    </nav>
  );
}
