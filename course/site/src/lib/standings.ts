/** The competition's rule (README "Winning"), as pure functions over one
 *  board: every driver's score and cost on one benchmark suite at the
 *  reference target.
 *
 *  A driver qualifies when its score, rounded to two decimals, is at least
 *  the baseline's and a full benchmark run costs less than the baseline's.
 *  The leader is the cheapest qualifier; with none, there is no leader.
 *  Everyone else ranks below the qualifiers: first those that clear the score
 *  bar but cost as much or more, cheapest first; then those under the bar,
 *  best score first; then those with nothing scored.
 *
 *  The combined board (`rankCombined`) puts every benchmark's board
 *  together: a driver qualifies on it by qualifying on each, and is ranked
 *  by the geometric mean of its cost ratios. */

import {
  BENCHMARK_SUITES,
  BENCHMARK_TASKS,
  ELIGIBILITY,
  REFERENCE_TARGET,
  type BenchmarkSuite,
  type Eligibility,
} from "@context-cup/shared/competition.js";

// The suites, target, and eligibility rule are the competition's, shared with
// bin/drivers; this file ranks by them.
export {
  BENCHMARK_SUITES,
  BENCHMARK_TASKS,
  ELIGIBILITY,
  REFERENCE_TARGET,
  type BenchmarkSuite,
  type Eligibility,
};

/** A benchmark's bar: a score, and what one full benchmark run costs (every
 *  task once: the leaderboard's $ / run), in cents. */
export type Baseline = { score: number; run_cents: number };

/** Each benchmark's bar at the reference target. */
export const BASELINES: Record<BenchmarkSuite, Baseline> = {
  tau_banking: { score: 0.42, run_cents: 4000 },
  toolathlon: { score: 0.58, run_cents: 2500 },
};

/** One driver's result on a board: its most recent eligible run of the
 *  suite at the target (the `run_eligibility` view), scored as a suite is. */
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

export type CombinedKind =
  | "leader"
  | "qualifies"
  /** Reaches every baseline's score, but costs as much or more on one. */
  | "costs_more"
  /** Under a baseline's score on at least one benchmark. */
  | "below_bar"
  /** No scored standing on at least one benchmark. */
  | "incomplete";

export type CombinedStanding = {
  driver_name: string;
  rank: number;
  kind: CombinedKind;
  /** Its standing on each benchmark's board, where it has one. */
  boards: Partial<Record<BenchmarkSuite, Standing>>;
  /** The geometric mean of its cost ratios, one per benchmark: below 1 is
   *  cheaper than the baselines. Null unless every benchmark has one. */
  cost_ratio: number | null;
  /** Its worse score ratio: below 1 is under a baseline's score. Null
   *  unless every benchmark has one. */
  score_ratio: number | null;
};

/** Every benchmark's board as one. A driver qualifies by qualifying on
 *  each; the leader is the qualifier with the lowest geometric mean of its
 *  cost ratios. The mean is the cost ratios' own, so the baselines' costs
 *  cancel out of the order: it is the order of the product of the drivers'
 *  run costs, and a benchmark counts for as much however dear its runs.
 *  Below the qualifiers: those that reach every score but not every budget,
 *  by the same mean; then those under a score, by their worse score ratio;
 *  then those without a scored standing on every benchmark. */
export function rankCombined(
  boards: Record<BenchmarkSuite, Board>
): CombinedStanding[] {
  const drivers = new Map<string, Partial<Record<BenchmarkSuite, Standing>>>();
  for (const suite of BENCHMARK_SUITES) {
    for (const s of boards[suite].standings) {
      drivers.set(s.driver_name, {
        ...drivers.get(s.driver_name),
        [suite]: s,
      });
    }
  }

  const combine = (
    name: string,
    mine: Partial<Record<BenchmarkSuite, Standing>>
  ) => {
    const each = BENCHMARK_SUITES.map((suite) => mine[suite]);
    const costs = each.map((s) => s?.cost_ratio ?? null);
    const scores = each.map((s) => s?.score_ratio ?? null);
    const cost_ratio = costs.every((r): r is number => r != null)
      ? Math.exp(costs.reduce((sum, r) => sum + Math.log(r), 0) / costs.length)
      : null;
    const score_ratio = scores.every((r): r is number => r != null)
      ? Math.min(...scores)
      : null;
    const kinds = each.map((s) => s?.kind);
    const kind: Exclude<CombinedKind, "leader"> = kinds.some(
      (k) => k == null || k === "unscored"
    )
      ? "incomplete"
      : kinds.some((k) => k === "below_bar" || k === "no_bar")
        ? "below_bar"
        : kinds.every((k) => k === "leader" || k === "qualifies")
          ? "qualifies"
          : "costs_more";
    return { driver_name: name, kind, boards: mine, cost_ratio, score_ratio };
  };

  const tier: Record<CombinedKind, number> = {
    leader: 0,
    qualifies: 0,
    costs_more: 1,
    below_bar: 2,
    incomplete: 3,
  };
  const cost = (c: { cost_ratio: number | null }) => c.cost_ratio ?? Infinity;
  const score = (c: { score_ratio: number | null }) =>
    c.score_ratio ?? -Infinity;

  return [...drivers]
    .map(([name, mine]) => combine(name, mine))
    .sort((a, b) => {
      const t = tier[a.kind] - tier[b.kind];
      if (t !== 0) return t;
      const byCost = tier[a.kind] <= 1;
      const primary = byCost ? cost(a) - cost(b) : score(b) - score(a);
      if (primary !== 0 && !Number.isNaN(primary)) return primary;
      const secondary = byCost ? score(b) - score(a) : cost(a) - cost(b);
      if (secondary !== 0 && !Number.isNaN(secondary)) return secondary;
      return a.driver_name.localeCompare(b.driver_name);
    })
    .map((c, i) => ({
      ...c,
      rank: i + 1,
      kind: i === 0 && c.kind === "qualifies" ? ("leader" as const) : c.kind,
    }));
}

/** What decides whether a run can stand on a leaderboard. */
/** A run's eligibility facts, from the `run_eligibility` view. */
export type RunFacts = {
  target_name: string;
  finished_at: Date | null;
  /** The target a suite of its name is judged at; null when it isn't a
   *  competition suite. */
  competition_target: string | null;
  /** Done trials each task needs; null when it isn't a competition suite. */
  min_done: number | null;
  required_tasks: number;
  /** Tasks of its suite it never ran. */
  missing_tasks: number;
  /** The fewest done trials any of its tasks has; null with no tasks. */
  min_task_done: number | null;
};

/** Why a run cannot stand on the competition's leaderboard, in words; empty
 *  when it can. The rule itself is the `run_eligibility` view's: this only
 *  says which of its facts fell short, so it holds no thresholds. */
export function disqualifications(run: RunFacts): string[] {
  const why: string[] = [];
  if (run.competition_target == null || run.min_done == null) {
    why.push("not a benchmark suite");
    if (!run.finished_at) why.push("not finished");
    return why;
  }
  if (run.target_name !== run.competition_target) {
    why.push(`target isn’t ${run.competition_target}`);
  }
  if (!run.finished_at) why.push("not finished");
  if (run.missing_tasks > 0) {
    const of = run.required_tasks;
    const ran = of - run.missing_tasks;
    why.push(
      `ran ${ran} of the suite’s ${of} ${of === 1 ? "task" : "tasks"}, not a full run`
    );
  }
  if (run.min_task_done == null) {
    why.push("no tasks");
  } else if (run.min_task_done < run.min_done) {
    why.push(
      `a task has ${run.min_task_done} completed ${run.min_task_done === 1 ? "trial" : "trials"}, needs ${run.min_done}`
    );
  }
  return why;
}
