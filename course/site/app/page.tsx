import hero from "@/public/hero.png";
import { PixelIcon, type IconName } from "@/src/components/pixel_icon";
import { Tabs } from "@/src/components/tabs";
import { count, dollars, reward } from "@/src/lib/format";
import { highlight } from "@/src/lib/highlight";
import { DOCS } from "@/src/lib/links";
import { countTrials, loadBoard } from "@/src/lib/queries";
import { loadSampleDrivers } from "@/src/lib/sample_driver";
import {
  BASELINES,
  BENCHMARK_SUITES,
  ELIGIBILITY,
  rankBoard,
  REFERENCE_TARGET,
  type Baseline,
  type Board,
} from "@/src/lib/standings";
import Image from "next/image";
import Link from "next/link";
import { Fragment, type CSSProperties } from "react";

export const dynamic = "force-dynamic";

/** Drivers shown per board before the rest fold into a “more” row. */
const TOP = 5;

export default async function Home() {
  const [trials, drivers, ...boards] = await Promise.all([
    countTrials(),
    loadSampleDrivers(),
    ...BENCHMARK_SUITES.map(async (name) => {
      const { tasks, entries } = await loadBoard(
        name,
        REFERENCE_TARGET,
        ELIGIBILITY
      );
      return { name, tasks, ...rankBoard(entries, BASELINES[name], tasks) };
    }),
  ]);

  const tallest = Math.max(...drivers.map((d) => d.code.split("\n").length));

  const stats: { icon: IconName; value: string; label: string }[] = [
    { icon: "trophy", value: "$100K", label: "Prize pool" },
    { icon: "stopwatch", value: count(trials), label: "Trials run" },
    { icon: "calendar", value: "Oct 24", label: "Submission deadline" },
  ];

  return (
    <>
      <section className="cc-hero mb-4">
        <div className="cc-hero-copy pt-5 pb-4">
          <h1 className="display-1 mb-4">
            Every token
            <br />
            <span className="text-primary">matters.</span>
          </h1>
          <p className="fs-5 mb-4" style={{ maxWidth: "40ch" }}>
            A coding competition to make the most efficient agentic context
            engine.
          </p>
          <a
            className="btn btn-primary btn-lg d-inline-flex align-items-center gap-3 px-4 py-3 mb-5"
            href={DOCS.entering}
          >
            Enter the cup
            <PixelIcon name="arrow" size={22} />
          </a>
          <div className="d-flex flex-wrap row-gap-3">
            {stats.map(({ icon, value, label }, i) => (
              <div
                className={`d-flex align-items-center gap-2 px-3${i > 0 ? " border-start border-secondary-subtle" : ""}`}
                key={label}
              >
                <PixelIcon name={icon} size={30} />
                <div>
                  <div className="h5 mb-0">{value}</div>
                  <div className="small text-uppercase text-body-secondary">
                    {label}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="cc-hero-art d-none d-lg-block">
          <Image
            src={hero}
            alt="A pixel-art kart racing under the Context Cup banner on a coastal road at sunset"
            priority
          />
        </div>
      </section>

      <section className="row g-3 mb-4">
        <Feature
          icon={<span className="h4 mb-0">&lt;/&gt;</span>}
          title="The challenge"
          href={DOCS.winning}
        >
          Build an agentic context engine that keeps the accuracy but uses fewer
          tokens.
        </Feature>
        <Feature
          icon={<PixelIcon name="document" size={36} />}
          title="Benchmarks"
          href={DOCS.benchmarks}
        >
          Real agent tasks, the same for every driver.
        </Feature>
        <Feature
          icon={<PixelIcon name="bars" size={36} />}
          title="Climb the leaderboard"
          href="/leaderboard"
        >
          The most efficient driver that reaches the baseline’s score leads each
          benchmark.
        </Feature>
      </section>

      <section className="row g-4">
        <div className="col-lg-7">
          <div
            data-bs-theme="dark"
            className="bg-body text-body border shadow h-100 p-2"
          >
            <Tabs labels={drivers.map((d) => d.lane)} className="px-1 pt-1">
              {drivers.map((d) => (
                <div key={d.lane}>
                  <div className="small text-body-secondary font-monospace px-2 pt-2">
                    {d.path}
                  </div>
                  <pre
                    className="cc-code"
                    style={{ "--cc-code-lines": tallest } as CSSProperties}
                  >
                    {highlight(d.code, d.language).map((line, i) => (
                      <span key={i}>
                        {line.map((t, j) =>
                          t.kind ? (
                            <span className={`cc-tok-${t.kind}`} key={j}>
                              {t.text}
                            </span>
                          ) : (
                            t.text
                          )
                        )}
                      </span>
                    ))}
                  </pre>
                </div>
              ))}
            </Tabs>
          </div>
        </div>
        <div className="col-lg-5">
          <div
            data-bs-theme="dark"
            className="bg-body text-body border shadow h-100 p-2"
          >
            <h2 className="h4 px-2 pt-2 mb-3">Top drivers</h2>
            <Tabs labels={boards.map((b) => b.name)} className="px-1">
              {boards.map((b) => (
                <TopDrivers key={b.name} name={b.name} board={b} />
              ))}
            </Tabs>
          </div>
        </div>
      </section>
    </>
  );
}

function Feature({
  icon,
  title,
  href,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className="col-lg-4">
      <Link
        className="cc-card-link border shadow text-reset text-decoration-none d-flex align-items-center gap-3 p-3 h-100"
        href={href}
      >
        <span
          data-bs-theme="dark"
          className="cc-icon-tile d-inline-flex align-items-center justify-content-center flex-shrink-0 bg-body text-body"
        >
          {icon}
        </span>
        <span>
          <span className="h5 d-block mb-1">{title}</span>
          <span className="small d-block">{children}</span>
        </span>
        <PixelIcon name="arrow" size={26} className="cc-arrow ms-auto" />
      </Link>
    </div>
  );
}

/** A board's first few drivers, with the baseline's row where it ranks
 *  (drivers above it qualify) and a row for any left out. */
function TopDrivers({ name, board }: { name: string; board: Board }) {
  const { standings, baseline } = board;
  // The baseline sits after the qualifiers, as on the leaderboard.
  const found = standings.findIndex(
    (s) => s.kind !== "leader" && s.kind !== "qualifies"
  );
  const at = found === -1 ? standings.length : found;
  const shown = standings.slice(0, TOP);
  const more = standings.length - shown.length;

  return (
    <div className="pt-3">
      {standings.length === 0 ? (
        <p className="px-2 mb-3">
          No eligible runs of <span className="font-monospace">{name}</span>{" "}
          yet.
        </p>
      ) : (
        <div className="table-responsive" data-bs-theme="light">
          <table className="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th className="text-end">#</th>
                <th>Driver</th>
                <th className="text-end">$ / run ↓</th>
                <th className="text-end">Score ↑</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s, i) => (
                <Fragment key={s.driver_name}>
                  {i === at && baseline && <BaselineRow baseline={baseline} />}
                  <tr className={s.kind === "leader" ? "table-warning" : ""}>
                    <td className="text-end font-monospace">{s.rank}</td>
                    <td className="font-monospace fw-semibold">
                      {s.driver_name}
                    </td>
                    <td className="text-end font-monospace">
                      {dollars(s.run_cents)}
                    </td>
                    <td className="text-end font-monospace">
                      {reward(s.mean_reward)}
                    </td>
                  </tr>
                </Fragment>
              ))}
              {more > 0 && (
                <tr>
                  <td />
                  <td colSpan={3} className="text-body-secondary">
                    … {more} more
                  </td>
                </tr>
              )}
              {at >= shown.length && baseline && (
                <BaselineRow baseline={baseline} />
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-end px-2 py-2">
        <Link
          className="d-inline-flex align-items-center gap-2"
          href={`/leaderboard/${name}`}
        >
          Full leaderboard <PixelIcon name="arrow" size={14} />
        </Link>
      </div>
    </div>
  );
}

function BaselineRow({ baseline }: { baseline: Baseline }) {
  return (
    <tr className="table-info">
      <td />
      <td className="fw-semibold">baseline</td>
      <td className="text-end font-monospace">{dollars(baseline.run_cents)}</td>
      <td className="text-end font-monospace">{reward(baseline.score)}</td>
    </tr>
  );
}
