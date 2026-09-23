/** Pure aggregation over trial rows, mirroring course/suite's scoring.ts:
 *  a job's score and cost are means over its done trials (a reward and no
 *  error), and a suite's are the means of its jobs' values, job-weighted.
 *  Nothing is stored; every page computes this from the rows it shows. */

export type TrialLike = {
  reward: number | null;
  error: string | null;
  costCents: number | null;
  turns: number | null;
};

export type TaskCell = {
  task_name: string;
  n: number;
  scored: number;
  errors: number;
  mean_reward: number | null;
  mean_cost_cents: number | null;
  mean_turns: number | null;
};

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Trials that completed with a verdict: the only ones that count. */
export function doneTrials<T extends TrialLike>(trials: T[]): T[] {
  return trials.filter((t) => t.reward != null && !t.error);
}

export function cellFor(task_name: string, trials: TrialLike[]): TaskCell {
  const scored = doneTrials(trials);
  return {
    task_name,
    n: trials.length,
    scored: scored.length,
    errors: trials.filter((t) => t.error).length,
    mean_reward: mean(scored.map((t) => t.reward!)),
    mean_cost_cents: mean(
      scored.flatMap((t) => (t.costCents == null ? [] : [t.costCents]))
    ),
    mean_turns: mean(scored.flatMap((t) => (t.turns == null ? [] : [t.turns]))),
  };
}

/** One cell per task, tasks sorted by name. */
export function taskCells<T extends TrialLike>(
  trials: Array<T & { task_name: string }>
): TaskCell[] {
  const byTask = new Map<string, T[]>();
  for (const t of trials) {
    const list = byTask.get(t.task_name) ?? [];
    list.push(t);
    byTask.set(t.task_name, list);
  }
  return [...byTask.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task_name, rows]) => cellFor(task_name, rows));
}

/** The ALL row: counts summed over the cells, means taken over the cells
 *  that have one (the suite is the mean of its jobs, not of its trials). */
export function suiteTotals(cells: TaskCell[]): TaskCell {
  const present = (pick: (c: TaskCell) => number | null) =>
    cells.flatMap((c) => {
      const v = pick(c);
      return v == null ? [] : [v];
    });
  return {
    task_name: "ALL",
    n: cells.reduce((s, c) => s + c.n, 0),
    scored: cells.reduce((s, c) => s + c.scored, 0),
    errors: cells.reduce((s, c) => s + c.errors, 0),
    mean_reward: mean(present((c) => c.mean_reward)),
    mean_cost_cents: mean(present((c) => c.mean_cost_cents)),
    mean_turns: mean(present((c) => c.mean_turns)),
  };
}
