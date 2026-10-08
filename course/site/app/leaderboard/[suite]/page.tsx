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
import { change, dollars, reward, when } from "@/src/lib/format";
import { loadBoard } from "@/src/lib/queries";
import {
  BASELINES,
  BENCHMARK_SUITES,
  ELIGIBILITY,
  rankBoard,
  REFERENCE_TARGET,
  type Standing,
} from "@/src/lib/standings";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ suite: string }>;
}): Promise<Metadata> {
  const { suite } = await params;
  return {
    title: `Leaderboard - ${suite}`,
    description: `Context engines on ${suite}, ranked by cost among those that match the baseline’s score.`,
  };
}

export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ suite: string }>;
}) {
  const { suite } = await params;
  const suite_name = BENCHMARK_SUITES.find((name) => name === suite);
  if (!suite_name) notFound();
  const { tasks, entries } = await loadBoard(suite_name, REFERENCE_TARGET);
  const { baseline, bar, budget, standings } = rankBoard(
    entries,
    BASELINES[suite_name],
    tasks
  );
  const leader = standings.find((s) => s.kind === "leader");
  const dots = standings.flatMap(dot);
  // The baseline's row sits where it would rank: after the qualifiers.
  const baselineAt = standings.findIndex(
    (s) => s.kind !== "leader" && s.kind !== "qualifies"
  );

  return (
    <>
      <h1 className="h3 mb-3">Leaderboard</h1>
      <p className="text-body-secondary">
        A driver qualifies with a score, to two decimals, at least the
        baseline’s and a full benchmark run that costs less; the cheapest
        qualifier leads. The rest rank below: those that reach the baseline’s
        score but cost more, cheapest first, then those under it, best score
        first. Each driver stands on its most recent finished run of the suite
        at <span className="font-monospace">{REFERENCE_TARGET}</span> that
        covers every task, with at least {ELIGIBILITY.min_done} completed trials
        in each. <Link href="/rules#winning">The rules</Link> have the rest.
      </p>

      <BoardTabs current={suite_name} />

      {entries.length === 0 ? (
        <div className="alert alert-secondary">
          No eligible runs of{" "}
          <span className="font-monospace">{suite_name}</span> at{" "}
          <span className="font-monospace">{REFERENCE_TARGET}</span> yet: a run
          needs to be finished and cover every task, with at least{" "}
          {ELIGIBILITY.min_done} completed trials in each.
        </div>
      ) : (
        <>
          {leader ? (
            <div className="alert alert-success">
              <span className="font-monospace fw-semibold">
                {leader.driver_name}
              </span>{" "}
              leads: score {reward(leader.mean_reward)} against the baseline’s{" "}
              {reward(bar)}, at {dollars(leader.run_cents)} per run against the
              baseline’s {dollars(budget)}.
            </div>
          ) : (
            <div className="alert alert-secondary">
              No leader: nothing scores at least {reward(bar)} for less than the
              baseline’s {dollars(budget)} per run.
            </div>
          )}

          <BoardFocus>
            <div className="row g-4">
              <div className="col-xl-6">
                <CostScoreChart
                  dots={dots}
                  baseline={
                    baseline && {
                      key: BASELINE_KEY,
                      name: "baseline",
                      x: baseline.run_cents / 100,
                      y: baseline.score,
                      kind: "other",
                      note: `baseline: score ${reward(baseline.score)}, ${dollars(baseline.run_cents)} per run`,
                      lines: [
                        ["score", reward(baseline.score)],
                        ["$ / run", dollars(baseline.run_cents)],
                      ],
                    }
                  }
                  unplotted={standings.length - dots.length}
                  scale="run"
                />
              </div>
              <div className="col-xl-6">
                <div className="table-responsive">
                  <table className="table table-sm table-striped table-hover align-middle mb-0">
                    <thead>
                      <tr>
                        <th className="text-end">#</th>
                        <th>driver</th>
                        <th className="text-end">score</th>
                        <th className="text-end">vs base</th>
                        <th className="text-end">$ / run</th>
                        <th className="text-end">vs base</th>
                        <th>run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.map((s, i) => (
                        <Fragment key={s.driver_name}>
                          {i === baselineAt && baseline && (
                            <BaselineRow
                              score={baseline.score}
                              run_cents={baseline.run_cents}
                            />
                          )}
                          <DriverRow s={s} />
                        </Fragment>
                      ))}
                      {baselineAt === -1 && baseline && (
                        <BaselineRow
                          score={baseline.score}
                          run_cents={baseline.run_cents}
                        />
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="small text-body-secondary mt-2 mb-0">
                  $ / run is a full benchmark run: the mean cost per task times
                  the suite’s {tasks} {tasks === 1 ? "task" : "tasks"}.
                </p>
              </div>
            </div>
          </BoardFocus>
        </>
      )}
    </>
  );
}

/** A driver's dot on the chart, if it has a score and a cost. */
function dot(s: Standing): ChartDot[] {
  if (s.mean_reward == null || s.run_cents == null) return [];
  return [
    {
      key: s.driver_name,
      name: s.driver_name,
      x: s.run_cents / 100,
      y: s.mean_reward,
      kind: s.kind === "leader" || s.kind === "qualifies" ? s.kind : "other",
      note: `#${s.rank} ${s.driver_name}: score ${reward(s.mean_reward)}, ${dollars(s.run_cents)} per run`,
      lines: [
        ["score", reward(s.mean_reward)],
        ["$ / run", dollars(s.run_cents)],
      ],
    },
  ];
}

function DriverRow({ s }: { s: Standing }) {
  return (
    <FocusRow focusKey={s.driver_name}>
      <td className="text-end font-monospace">{s.rank}</td>
      <td className="font-monospace">{s.driver_name}</td>
      <td className="text-end font-monospace">{reward(s.mean_reward)}</td>
      <td className="text-end font-monospace">{change(s.score_ratio)}</td>
      <td className="text-end font-monospace">{dollars(s.run_cents)}</td>
      <td className="text-end font-monospace">{change(s.cost_ratio)}</td>
      <td className="font-monospace">
        <a href={`/suites/${s.suite_id}`} className="link-secondary">
          {when(s.suite_started_at)}
        </a>
      </td>
    </FocusRow>
  );
}

/** The bar itself, unranked, where it would rank: drivers above it
 *  qualify, drivers below do not. */
function BaselineRow({
  score,
  run_cents,
}: {
  score: number;
  run_cents: number;
}) {
  return (
    <FocusRow focusKey={BASELINE_KEY} className="table-dark fw-semibold">
      <td />
      <td>baseline</td>
      <td className="text-end font-monospace">{reward(score)}</td>
      <td />
      <td className="text-end font-monospace">{dollars(run_cents)}</td>
      <td />
      <td />
    </FocusRow>
  );
}
