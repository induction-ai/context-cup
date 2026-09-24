/** The score of a run, defined once.
 *
 *  A trial has a reward from the verifier, or an error. A task's score is the
 *  mean reward over its done trials (a reward and no error), across all its
 *  jobs (a `--retry_errors` pass adds a job to the same task); its cost is the
 *  mean over the done trials that were priced. Errored, timed-out, and
 *  unfinished trials are left out, never counted as zero. A suite's score is
 *  the mean of its tasks' scores, task-weighted, and its cost the mean of
 *  their costs. Nothing here is stored: it is computed wherever it is shown.
 *  (`jobScore` and `jobMeanCost` take any set of trials: one job's or one
 *  task's.) */

export type ScoredTrial = {
  reward: number | null;
  error: string | null;
  cost_cents: number | null;
};

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Trials that count toward a score: rewarded and not errored. */
export function scoredTrials<T extends ScoredTrial>(trials: readonly T[]): T[] {
  return trials.filter((t) => t.reward !== null && t.error === null);
}

export function jobScore(trials: readonly ScoredTrial[]): number | null {
  return mean(scoredTrials(trials).map((t) => t.reward!));
}

/** Over done trials only, like the score; a done trial without a price is
 *  skipped rather than counted as free. */
export function jobMeanCost(trials: readonly ScoredTrial[]): number | null {
  return mean(
    scoredTrials(trials).flatMap((t) =>
      t.cost_cents === null ? [] : [t.cost_cents]
    )
  );
}

/** The mean of the jobs' values, skipping jobs that have none. */
export function suiteMean(
  jobValues: ReadonlyArray<number | null>
): number | null {
  return mean(jobValues.flatMap((v) => (v === null ? [] : [v])));
}
