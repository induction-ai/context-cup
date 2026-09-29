/** The competition's rule (README "Winning"), as pure functions over one
 *  board: every driver's score and cost on one benchmark suite at the
 *  reference target.
 *
 *  A driver qualifies when its score, rounded to two decimals, is at least
 *  the baseline's and a full benchmark run costs less than the baseline's.
 *  The leader is the cheapest qualifier; with none, there is no leader.
 *  Everyone else ranks below the qualifiers: first those that clear the score
 *  bar but cost as much or more, cheapest first; then those under the bar,
 *  best score first; then those with nothing scored. */

import { REFERENCE_TARGET } from "@context-cup/shared/reference_target.js";
import tauBanking from "../../../../suites/tau_banking.json";
import toolathlon from "../../../../suites/toolathlon.json";

/** The suite files the competition is judged on, one per benchmark. */
export const BENCHMARK_SUITES = ["tau_banking", "toolathlon"] as const;
export type BenchmarkSuite = (typeof BENCHMARK_SUITES)[number];

/** The tasks a suite file runs by default (all but its `explicit_only`
 *  ones), as `bin/suite` without `--task` does. */
function defaultTasks(file: {
  tasks: Record<string, { runner: string; explicit_only?: boolean }>;
}): readonly string[] {
  return Object.entries(file.tasks)
    .filter(([, t]) => !t.explicit_only)
    .map(([name]) => name);
}

/** Every task a full run of each benchmark covers. */
export const BENCHMARK_TASKS: Record<BenchmarkSuite, readonly string[]> = {
  tau_banking: defaultTasks(tauBanking),
  toolathlon: defaultTasks(toolathlon),
};

/** A benchmark's bar: a score, and what one full benchmark run costs (every
 *  task once: the leaderboard's $ / run), in cents. */
export type Baseline = { score: number; run_cents: number };

/** Each benchmark's bar at the reference target. */
export const BASELINES: Record<BenchmarkSuite, Baseline> = {
  tau_banking: { score: 0.44, run_cents: 4000 },
  toolathlon: { score: 0.67, run_cents: 6500 },
};

/** What a run needs to stand on a leaderboard. */
export type Eligibility = {
  /** Done trials (a reward and no error) every task needs, retry passes
   *  included. */
  min_done: number;
  /** By suite name, the tasks a run must cover: a full run, not one
   *  narrowed by `--task`. A suite not named here has no such rule. */
  tasks: Record<string, readonly string[]>;
};

/** A run stands on a board only once finished, covering every task of its
 *  suite, with at least `min_done` done trials in each, retry passes
 *  included. A driver's latest such run is its entry. */
export const ELIGIBILITY: Eligibility = {
  min_done: 2,
  tasks: BENCHMARK_TASKS,
};
/** The target the competition is judged at. */
export { REFERENCE_TARGET };

/** One driver's result on a board: its most recent eligible run of the
 *  suite at the target (ELIGIBILITY), scored as a suite is. */
export type Entry = {
  driver_name: string;
  suite_id: string;
  suite_started_at: Date;
  trials: number;
  scored: number;
  errors: number;
  /** Tasks with at least one done trial. */
  tasks_scored: number;
  mean_reward: number | null;
  /** Mean over tasks of each task's mean cost; times the task count, the
   *  cost of a full benchmark run. */
  mean_cost_cents: number | null;
};

export type StandingKind =
  | "leader"
  | "qualifies"
  | "costs_more"
  | "below_bar"
  /** No baseline for this suite, so no bar to measure against. */
  | "no_bar"
  | "unscored";

export type Standing = Entry & {
  rank: number;
  kind: StandingKind;
  /** A full benchmark run: the mean task cost times the suite's tasks. */
  run_cents: number | null;
  /** Score and run cost as fractions of the baseline's, when there is one. */
  score_ratio: number | null;
  cost_ratio: number | null;
};

export type Board = {
  baseline: Baseline | null;
  /** The score a qualifier must reach, and the run cost it must beat. */
  bar: number | null;
  budget: number | null;
  standings: Standing[];
};

/** Floating-point slack, so a mean that lands on the baseline's score
 *  meets it. */
const EPS = 1e-9;

/** A score as it is judged and shown: to two decimals, halves up. The slack
 *  keeps a mean like 0.435, stored as 0.43499…, rounding up. */
export function roundScore(score: number): number {
  return Math.round(score * 100 + EPS * 100) / 100;
}

export function rankBoard(
  entries: Entry[],
  baseline: Baseline | null,
  /** The suite's task count, turning a mean task cost into a run's. */
  tasks: number
): Board {
  const bar = baseline ? baseline.score : null;
  const budget = baseline ? baseline.run_cents : null;
  const runCents = (e: Entry) =>
    e.mean_cost_cents == null ? null : e.mean_cost_cents * tasks;

  const classify = (e: Entry): Exclude<StandingKind, "leader"> => {
    if (e.mean_reward == null) return "unscored";
    if (bar == null || budget == null) return "no_bar";
    if (roundScore(e.mean_reward) < bar - EPS) return "below_bar";
    const run = runCents(e);
    return run != null && run < budget - EPS ? "qualifies" : "costs_more";
  };
  const tier: Record<StandingKind, number> = {
    leader: 0,
    qualifies: 0,
    costs_more: 1,
    below_bar: 2,
    no_bar: 2,
    unscored: 3,
  };
  const cost = (e: Entry) => e.mean_cost_cents ?? Infinity;
  const score = (e: Entry) => e.mean_reward ?? -Infinity;

  const ranked = entries
    .map((e) => ({ e, kind: classify(e) }))
    .sort((a, b) => {
      const t = tier[a.kind] - tier[b.kind];
      if (t !== 0) return t;
      // Qualifiers and those that cost more are ordered by cost; those under
      // the bar (or with no bar) by score. The other measure breaks ties.
      const byCost = tier[a.kind] <= 1;
      const primary = byCost ? cost(a.e) - cost(b.e) : score(b.e) - score(a.e);
      if (primary !== 0 && !Number.isNaN(primary)) return primary;
      const secondary = byCost
        ? score(b.e) - score(a.e)
        : cost(a.e) - cost(b.e);
      if (secondary !== 0 && !Number.isNaN(secondary)) return secondary;
      return a.e.driver_name.localeCompare(b.e.driver_name);
    });

  const standings = ranked.map(({ e, kind }, i) => {
    const run = runCents(e);
    return {
      ...e,
      rank: i + 1,
      kind: i === 0 && kind === "qualifies" ? ("leader" as const) : kind,
      run_cents: run,
      score_ratio:
        baseline && e.mean_reward != null && baseline.score > 0
          ? e.mean_reward / baseline.score
          : null,
      cost_ratio:
        baseline && run != null && baseline.run_cents > 0
          ? run / baseline.run_cents
          : null,
    };
  });
  return { baseline, bar, budget, standings };
}

/** What decides whether a run can stand on a leaderboard. */
export type RunFacts = {
  name: string;
  target_name: string;
  finished_at: Date | null;
  /** The fewest done trials any of its tasks has; null with no tasks. */
  min_task_done: number | null;
  /** Tasks of its suite (Eligibility `tasks`) it never ran. */
  missing_tasks: number;
};

/** Why a run cannot stand on the competition's leaderboard; empty when it
 *  can. The same rule as the eligibility SQL in `queries.ts`, plus the suite
 *  and target the competition is judged on. */
export function disqualifications(
  run: RunFacts,
  rules: Eligibility = ELIGIBILITY
): string[] {
  const why: string[] = [];
  if (!(BENCHMARK_SUITES as readonly string[]).includes(run.name)) {
    why.push("not a benchmark suite");
  }
  if (run.target_name !== REFERENCE_TARGET) {
    why.push(`target isn’t ${REFERENCE_TARGET}`);
  }
  if (!run.finished_at) why.push("not finished");
  if (run.missing_tasks > 0) {
    const of = rules.tasks[run.name]?.length ?? 0;
    const ran = of - run.missing_tasks;
    why.push(
      `ran ${ran} of the suite’s ${of} ${of === 1 ? "task" : "tasks"}, not a full run`
    );
  }
  if (run.min_task_done == null) {
    why.push("no tasks");
  } else if (run.min_task_done < rules.min_done) {
    why.push(
      `a task has ${run.min_task_done} completed ${run.min_task_done === 1 ? "trial" : "trials"}, needs ${rules.min_done}`
    );
  }
  return why;
}
