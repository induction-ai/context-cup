/** --retry_errors: after the queue drains, rerun the trials that did not
 *  finish, up to N more passes. Every attempt is kept: a retry pass is a new
 *  job for the same task, and a task's score is the mean over the done trials
 *  of all its jobs (see scoring.ts). */
import type { SuiteRun } from "./expand.ts";

/** Above this share of expected trials still unfinished, --retry_errors
 *  skips its passes: that many failures point at something broken that a
 *  retry would only repeat. */
export const RETRY_ERRORS_MAX_FAILURE_RATE = 0.5;

/** Whether a pass should rerun `shortfall` unfinished trials out of
 *  `expected`. */
export function shouldRetryErrors(
  shortfall: number,
  expected: number
): boolean {
  return shortfall > 0 && shortfall <= expected * RETRY_ERRORS_MAX_FAILURE_RATE;
}

/** Each run cut down to the trials it still owes (its count minus its done
 *  trials so far, by task name); runs that owe none are dropped. */
export function shortfallRuns(
  runs: readonly SuiteRun[],
  done: ReadonlyMap<string, number>
): SuiteRun[] {
  return runs.flatMap((run) => {
    const owed = run.count - (done.get(run.task_name) ?? 0);
    return owed > 0 ? [{ ...run, count: owed }] : [];
  });
}

export function totalCount(runs: readonly SuiteRun[]): number {
  return runs.reduce((n, run) => n + run.count, 0);
}
