import { SortTh } from "@/src/components/sort_th";
import {
  cents,
  elapsed,
  githubRunUrl,
  reward,
  targetSpec,
  when,
} from "@/src/lib/format";
import {
  listSuites,
  SUITE_SORT_KEYS,
  type SuiteSummary,
} from "@/src/lib/queries";
import { pageHref, parsePage, parseSort } from "@/src/lib/sort";
import { disqualifications } from "@/src/lib/standings";
import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Suites" };

const NUMERIC: ReadonlySet<string> = new Set([
  "tasks",
  "count",
  "duration",
  "trials",
  "done",
  "errors",
  "reward",
  "cost",
]);

export default async function SuitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sort = parseSort(params, SUITE_SORT_KEYS, {
    key: "started",
    dir: "desc",
  });
  const page = parsePage(params);
  const { rows: suites, total } = await listSuites({ sort, page });
  const pages = Math.max(1, Math.ceil(total / page.per));
  const first = total === 0 ? 0 : (page.page - 1) * page.per + 1;
  const last = Math.min(total, page.page * page.per);
  return (
    <>
      <h1 className="h3 mb-3">Suites</h1>
      {suites.length === 0 ? (
        <div className="alert alert-secondary">
          No runs yet. Start one with bin/suite.
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-striped table-hover align-middle mb-0">
            <thead>
              <tr>
                {SUITE_SORT_KEYS.map((col) => (
                  <SortTh
                    key={col}
                    path="/suites"
                    current={sort}
                    column={col}
                    label={col}
                    numeric={NUMERIC.has(col)}
                    firstDir={col === "started" ? "desc" : undefined}
                  />
                ))}
                <th>leaderboard</th>
                <th>run</th>
              </tr>
            </thead>
            <tbody>
              {suites.map((s) => {
                const gh = githubRunUrl(s);
                return (
                  <tr key={s.id}>
                    <td className="font-monospace">
                      <Link href={`/suites/${s.id}`}>{s.id}</Link>
                    </td>
                    <td>{s.name}</td>
                    <td className="font-monospace">{s.driver_name}</td>
                    <td>
                      {s.target_name}
                      <br />
                      <span className="text-body-secondary font-monospace">
                        {targetSpec(s)}
                      </span>
                    </td>
                    <td className="text-end font-monospace">{s.tasks}</td>
                    <td className="text-end font-monospace">{s.count}</td>
                    <td className="font-monospace">{when(s.started_at)}</td>
                    <td className="text-end font-monospace">
                      {s.finished_at
                        ? elapsed(s.started_at, s.finished_at)
                        : "running"}
                    </td>
                    <td className="text-end font-monospace">{s.trials}</td>
                    <td className="text-end font-monospace">{s.scored}</td>
                    <td
                      className={`text-end font-monospace${s.errors > 0 ? " text-danger" : ""}`}
                    >
                      {s.errors}
                    </td>
                    <td className="text-end font-monospace">
                      {reward(s.mean_reward)}
                    </td>
                    <td className="text-end font-monospace">
                      {cents(s.mean_cost_cents)}
                    </td>
                    <td>
                      <BoardCell suite={s} />
                    </td>
                    <td>
                      {gh ? (
                        <a href={gh}>GitHub</a>
                      ) : (
                        <span className="text-body-secondary">local</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <nav
            className="d-flex align-items-center gap-3 mt-3"
            aria-label="pages"
          >
            <ul className="pagination pagination-sm mb-0">
              <PageItem
                label="Previous"
                target={page.page - 1}
                disabled={page.page <= 1}
                sort={sort}
                page={page}
              />
              {pageWindow(page.page, pages).map((n) => (
                <PageItem
                  key={n}
                  label={String(n)}
                  target={n}
                  active={n === page.page}
                  sort={sort}
                  page={page}
                />
              ))}
              <PageItem
                label="Next"
                target={page.page + 1}
                disabled={page.page >= pages}
                sort={sort}
                page={page}
              />
            </ul>
            <span className="text-body-secondary">
              {first}–{last} of {total}
            </span>
          </nav>
        </div>
      )}
    </>
  );
}

/** Whether the run stands on the leaderboard; hovering the tag says why
 *  (a `title`, so no client script), and screen readers get the same text. */
function BoardCell({ suite }: { suite: SuiteSummary }) {
  const why = disqualifications(suite);
  if (why.length > 0) {
    return (
      <Tag className="text-bg-light border" note={why.join("\n")}>
        doesn’t qualify
      </Tag>
    );
  }
  if (suite.on_board) {
    return (
      <a
        href={`/leaderboard/${suite.name}`}
        className="badge text-bg-success"
        title="the run this driver stands on"
      >
        on board
      </a>
    );
  }
  return (
    <Tag
      className="text-bg-secondary"
      note="a newer qualifying run replaces it"
    >
      superseded
    </Tag>
  );
}

function Tag({
  className,
  note,
  children,
}: {
  className: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`badge ${className}`} title={note}>
      {children}
      <span className="visually-hidden">: {note.replaceAll("\n", "; ")}</span>
    </span>
  );
}

/** Up to seven page numbers around the current one. */
function pageWindow(current: number, pages: number): number[] {
  const lo = Math.max(1, Math.min(current - 3, pages - 6));
  const hi = Math.min(pages, lo + 6);
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) out.push(n);
  return out;
}

function PageItem({
  label,
  target,
  active,
  disabled,
  sort,
  page,
}: {
  label: string;
  target: number;
  active?: boolean;
  disabled?: boolean;
  sort: Parameters<typeof pageHref>[1];
  page: Parameters<typeof pageHref>[2];
}) {
  const cls = `page-item${active ? " active" : ""}${disabled ? " disabled" : ""}`;
  return (
    <li className={cls} aria-current={active ? "page" : undefined}>
      {disabled || active ? (
        <span className="page-link">{label}</span>
      ) : (
        <a className="page-link" href={pageHref("/suites", sort, page, target)}>
          {label}
        </a>
      )}
    </li>
  );
}
