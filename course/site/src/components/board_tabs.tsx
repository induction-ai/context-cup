import { BENCHMARK_SUITES } from "@/src/lib/standings";
import Link from "next/link";

/** The leaderboards: the combined one, then one per benchmark. `current`
 *  is a suite name, or null for the combined board. */
export function BoardTabs({ current }: { current: string | null }) {
  const boards = [
    { key: null, label: "combined", href: "/leaderboard" },
    ...BENCHMARK_SUITES.map((name) => ({
      key: name,
      label: name,
      href: `/leaderboard/${name}`,
    })),
  ];
  return (
    <ul className="nav nav-pills gap-2 mb-3">
      {boards.map(({ key, label, href }) => (
        <li className="nav-item" key={label}>
          <Link
            className={`nav-link border${key === current ? " active" : ""}`}
            aria-current={key === current ? "page" : undefined}
            href={href}
          >
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
