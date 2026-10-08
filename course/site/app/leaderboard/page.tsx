import {
  BASELINE_KEY,
  BoardFocus,
  FocusRow,
} from "@/src/components/board_focus";
import { BoardTabs } from "@/src/components/board_tabs";
import {
  CostScoreChart,
  type ChartDot,
} from "@/src/components/cost_score_chart";
import { change, dollars, reward } from "@/src/lib/format";
import { loadBoard } from "@/src/lib/queries";
import {
  BASELINES,
  BENCHMARK_SUITES,
  ELIGIBILITY,
  rankBoard,
  rankCombined,
  REFERENCE_TARGET,
  type BenchmarkSuite,
  type Board,
  type CombinedStanding,
} from "@/src/lib/standings";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
  description:
    "Context engines ranked across every benchmark: those that beat every baseline, by how much less they spend.",
};

/** Every benchmark's board as one (`rankCombined`). */
export default async function CombinedLeaderboard() {
  const boards = Object.fromEntries(
    await Promise.all(
      BENCHMARK_SUITES.map(async (name) => {
        const { tasks, entries } = await loadBoard(name, REFERENCE_TARGET);
        return [name, rankBoard(entries, BASELINES[name], tasks)] as const;
      })
    )
  ) as Record<BenchmarkSuite, Board>;
  const standings = rankCombined(boards);
  const leader = standings.find((s) => s.kind === "leader");
  // The baseline's row sits where it would rank: after the qualifiers.
  const baselineAt = standings.findIndex(
    (s) => s.kind !== "leader" && s.kind !== "qualifies"
  );
  const dots = standings.flatMap(dot);

  return (
    <>
      <h1 className="h3 mb-3">Leaderboard</h1>
      <p className="text-body-secondary">
        This board’s leader wins the cup. A driver qualifies here by qualifying
        on every benchmark: at least the baseline’s score, for a cheaper full
        run. Qualifiers rank by the geometric mean of their cost ratios (each
        benchmark’s run cost over its baseline’s), so halving a cost counts the
        same on either benchmark. The rest rank below: those that reach every
        score but not every budget, by the same mean, then those under a score,
        by their worse score ratio, then those without an eligible run of every
        benchmark. <Link href="/rules#winning">The rules</Link> have the rest.
      </p>

      <BoardTabs current={null} />

      {standings.length === 0 ? (
        <div className="alert alert-secondary">
          No eligible runs at{" "}
          <span className="font-monospace">{REFERENCE_TARGET}</span> yet: a run
          needs to be finished and cover every task, with at least{" "}
          {ELIGIBILITY.min_done} valid trials in each.
        </div>
      ) : (
        <>
          {leader ? (
            <div className="alert alert-success">
              <span className="font-monospace fw-semibold">
                {leader.driver_name}
              </span>{" "}
              leads: it clears every baseline’s score, spending{" "}
              {(100 * (1 - (leader.cost_ratio ?? 1))).toFixed(1)}% less than the
              baselines (the geometric mean across benchmarks).
            </div>
          ) : (
            <div className="alert alert-secondary">
              No leader: no driver clears every baseline’s score for less on
              every benchmark.
            </div>
          )}

          <BoardFocus>
            <div className="row g-4">
              <div className="col-xl-6">
                <CostScoreChart
                  dots={dots}
                  baseline={{
                    key: BASELINE_KEY,
                    name: "baseline",
                    x: 1,
                    y: 1,
                    kind: "other",
                    note: "baseline: every benchmark’s bar",
                    lines: [],
                  }}
                  unplotted={standings.length - dots.length}
                  scale="ratio"
                />
              </div>
              <div className="col-xl-6">
                <div className="table-responsive">
                  <table className="table table-sm table-striped table-hover align-middle mb-0">
                    <thead>
                      <tr>
                        <th rowSpan={2} className="text-end">
                          #
                        </th>
                        <th rowSpan={2}>driver</th>
                        {BENCHMARK_SUITES.map((name) => (
                          <th
                            key={name}
                            colSpan={2}
                            className="text-center font-monospace"
                          >
                            <Link
                              href={`/leaderboard/${name}`}
                              className="link-body-emphasis"
                            >
                              {name}
                            </Link>
                          </th>
                        ))}
                        <th colSpan={2} className="text-center">
                          vs base
                        </th>
                      </tr>
                      <tr>
                        {BENCHMARK_SUITES.map((name) => (
                          <Fragment key={name}>
                            <th className="text-end">score</th>
                            <th className="text-end">$ / run</th>
                          </Fragment>
                        ))}
                        <th className="text-end">cost</th>
                        <th className="text-end">score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.map((s, i) => (
                        <Fragment key={s.driver_name}>
                          {i === baselineAt && <BaselineRow />}
                          <DriverRow s={s} />
                        </Fragment>
                      ))}
                      {baselineAt === -1 && <BaselineRow />}
                    </tbody>
                  </table>
                </div>
                <p className="small text-body-secondary mt-2 mb-0">
                  Red is a miss: a score under the baseline’s, or a run that
                  costs as much or more. Cost vs base is the geometric mean of
                  each benchmark’s run cost over its baseline’s; score vs base
                  is the worse of each score over its baseline’s.
                </p>
              </div>
            </div>
          </BoardFocus>
        </>
      )}
    </>
  );
}

/** A driver's dot on the chart, if it has both ratios. */
function dot(s: CombinedStanding): ChartDot[] {
  if (s.cost_ratio == null || s.score_ratio == null) return [];
  const cost = change(s.cost_ratio);
  const score = change(s.score_ratio);
  return [
    {
      key: s.driver_name,
      name: s.driver_name,
      x: s.cost_ratio,
      y: s.score_ratio,
      kind: s.kind === "leader" || s.kind === "qualifies" ? s.kind : "other",
      note: `#${s.rank} ${s.driver_name}: cost ${cost} vs the baselines, score ${score} vs the baselines`,
      lines: [
        ["cost vs base", cost],
        ["score vs base", score],
      ],
    },
  ];
}

function DriverRow({ s }: { s: CombinedStanding }) {
  return (
    <FocusRow focusKey={s.driver_name}>
      <td className="text-end font-monospace">{s.rank}</td>
      <td className="font-monospace">{s.driver_name}</td>
      {BENCHMARK_SUITES.map((name) => {
        const b = s.boards[name];
        if (!b) {
          return (
            <Fragment key={name}>
              <td className="text-end text-body-secondary">–</td>
              <td className="text-end text-body-secondary">–</td>
            </Fragment>
          );
        }
        const missesScore = b.kind === "below_bar" || b.kind === "unscored";
        const missesCost =
          b.run_cents == null || b.run_cents >= BASELINES[name].run_cents;
        return (
          <Fragment key={name}>
            <td
              className={`text-end font-monospace${missesScore ? " text-danger" : ""}`}
            >
              {reward(b.mean_reward)}
            </td>
            <td
              className={`text-end font-monospace${missesCost ? " text-danger" : ""}`}
            >
              {dollars(b.run_cents)}
            </td>
          </Fragment>
        );
      })}
      <td className="text-end font-monospace">{change(s.cost_ratio)}</td>
      <td className="text-end font-monospace">{change(s.score_ratio)}</td>
    </FocusRow>
  );
}

/** Every benchmark's bar, unranked, where it would rank: drivers above it
 *  qualify, drivers below do not. */
function BaselineRow() {
  return (
    <FocusRow focusKey={BASELINE_KEY} className="table-dark fw-semibold">
      <td />
      <td>baseline</td>
      {BENCHMARK_SUITES.map((name) => (
        <Fragment key={name}>
          <td className="text-end font-monospace">
            {reward(BASELINES[name].score)}
          </td>
          <td className="text-end font-monospace">
            {dollars(BASELINES[name].run_cents)}
          </td>
        </Fragment>
      ))}
      <td />
      <td />
    </FocusRow>
  );
}
