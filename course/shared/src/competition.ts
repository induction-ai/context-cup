/** What the competition is judged on (README "Winning"): the suites, the
 *  target, and what a run needs to count. The site's leaderboard
 *  (`course/site/src/lib/standings.ts`) ranks by it, and `bin/drivers sync`
 *  writes it to the database for the `driver_status` view. */

import tauBanking from "../../../suites/tau_banking.json" with { type: "json" };
import toolathlon from "../../../suites/toolathlon.json" with { type: "json" };
import { REFERENCE_TARGET } from "./reference_target.ts";

export { REFERENCE_TARGET };

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
