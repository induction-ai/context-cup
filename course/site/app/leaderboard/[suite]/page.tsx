import {
  BASELINE_KEY,
  BoardFocus,
  FocusRow,
} from "@/src/components/board_focus";
import { CostScoreChart } from "@/src/components/cost_score_chart";
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
import { notFound } from "next/navigation";
import { Fragment } from "react";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ suite: string }>;
}) {
  const { suite } = await params;
  const suite_name = BENCHMARK_SUITES.find((name) => name === suite);
  if (!suite_name) notFound();
  const { tasks, entries } = await loadBoard(
    suite_name,
    REFERENCE_TARGET,
    ELIGIBILITY
  );
  const { baseline, bar, budget, standings } = rankBoard(
    entries,
    BASELINES[suite_name],
    tasks
  );
  const leader = standings.find((s) => s.kind === "leader");
  // The baseline's row sits where it would rank: after the qualifiers.
  const baselineAt = standings.findIndex(
    (s) => s.kind !== "leader" && s.kind !== "qualifies"
  );

  return (
    <>
      <h1 className="h3 mb-3">Leaderboard</h1>
      <p className="text-body-secondary">
        A driver qualifies with a score at least the baseline’s and a full
        benchmark run that costs less; the cheapest qualifier leads. The rest
        rank below: those that reach the baseline’s score but cost more,
        cheapest first, then those under it, best score first. Each driver
        stands on its most recent finished run of the suite at{" "}
        <span className="font-monospace">{REFERENCE_TARGET}</span> with at least{" "}
        {ELIGIBILITY.min_count} attempts per task and at least{" "}
        {ELIGIBILITY.min_done} finished trials in every task.
      </p>

      <ul className="nav nav-pills gap-2 mb-3">
        {BENCHMARK_SUITES.map((name) => (
          <li className="nav-item" key={name}>
            <a
              className={`nav-link border${name === suite_name ? " active" : ""}`}
              href={`/leaderboard/${name}`}
            >
              {name}
            </a>
          </li>
        ))}
      </ul>

      {entries.length === 0 ? (
        <div className="alert alert-secondary">
          No eligible runs of{" "}
          <span className="font-monospace">{suite_name}</span> at{" "}
          <span className="font-monospace">{REFERENCE_TARGET}</span> yet: a run
          needs to be finished, with at least {ELIGIBILITY.min_count} attempts
          per task and at least {ELIGIBILITY.min_done} finished trials in every
          task.
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
                  standings={standings}
                  baseline={baseline}
                  bar={bar}
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
