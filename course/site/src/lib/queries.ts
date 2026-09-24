/** Every read the pages make. Plain functions returning rows; the pages do
 *  the rendering and `aggregate.ts` does the arithmetic. */
import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, modelCall, suite, trial } from "@context-cup/db/schema.js";
import { asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Page, Sort } from "./sort";

export type SuiteRow = typeof suite.$inferSelect;
export type JobRow = typeof job.$inferSelect;
export type TrialRow = typeof trial.$inferSelect;
export type ModelCallRow = typeof modelCall.$inferSelect;

/** What the suites index shows per run: the row, trial counts, and the
 *  suite's score and cost: the mean over its tasks of each task's mean over
 *  its done trials, across all of the task's jobs (see aggregate.ts). */
export type SuiteSummary = SuiteRow & {
  /** Tasks in the suite; a `--retry_errors` pass adds jobs, not tasks. */
  tasks: number;
  trials: number;
  scored: number;
  errors: number;
  mean_reward: number | null;
  mean_cost_cents: number | null;
};

export const SUITE_SORT_KEYS = [
  "suite",
  "name",
  "driver",
  "target",
  "tasks",
  "count",
  "started",
  "duration",
  "trials",
  "done",
  "errors",
  "reward",
  "cost",
] as const;
export type SuiteSortKey = (typeof SUITE_SORT_KEYS)[number];

/** One page of suites, sorted in the database so the slice is right. */
export async function listSuites(options: {
  sort: Sort<SuiteSortKey>;
  page: Page;
}): Promise<{ rows: SuiteSummary[]; total: number }> {
  const db = getCurrentTransaction();
  const rollup = db
    .select({
      suiteId: trial.suiteId,
      trials: sql<number>`count(*)::int`.as("trials"),
      scored:
        sql<number>`count(*) filter (where ${trial.reward} is not null and ${trial.error} is null)::int`.as(
          "scored"
        ),
      errors:
        sql<number>`count(*) filter (where ${trial.error} is not null)::int`.as(
          "errors"
        ),
    })
    .from(trial)
    .groupBy(trial.suiteId)
    .as("rollup");
  // A task's means over its done trials in all its jobs, then the suite's
  // mean over its tasks.
  const done = sql`${trial.reward} is not null and ${trial.error} is null`;
  const taskMeans = db
    .select({
      suiteId: trial.suiteId,
      taskName: job.taskName,
      task_reward: sql<
        number | null
      >`avg(${trial.reward}) filter (where ${done})`.as("task_reward"),
      task_cost: sql<
        number | null
      >`avg(${trial.costCents}) filter (where ${done})`.as("task_cost"),
    })
    .from(trial)
    .innerJoin(job, eq(job.id, trial.jobId))
    .groupBy(trial.suiteId, job.taskName)
    .as("task_means");
  const scores = db
    .select({
      suiteId: taskMeans.suiteId,
      mean_reward: sql<number | null>`avg(${taskMeans.task_reward})`.as(
        "mean_reward"
      ),
      mean_cost_cents: sql<number | null>`avg(${taskMeans.task_cost})`.as(
        "mean_cost_cents"
      ),
    })
    .from(taskMeans)
    .groupBy(taskMeans.suiteId)
    .as("scores");
  const jobCounts = db
    .select({
      suiteId: job.suiteId,
      tasks: sql<number>`count(distinct ${job.taskName})::int`.as("tasks"),
    })
    .from(job)
    .groupBy(job.suiteId)
    .as("job_counts");

  const sortExpr: Record<SuiteSortKey, SQL> = {
    suite: sql`${suite.id}`,
    name: sql`${suite.name}`,
    driver: sql`${suite.driverName}`,
    target: sql`${suite.targetName}`,
    tasks: sql`${jobCounts.tasks}`,
    count: sql`${suite.count}`,
    started: sql`${suite.startedAt}`,
    duration: sql`${suite.finishedAt} - ${suite.startedAt}`,
    trials: sql`${rollup.trials}`,
    done: sql`${rollup.scored}`,
    errors: sql`${rollup.errors}`,
    reward: sql`${scores.mean_reward}`,
    cost: sql`${scores.mean_cost_cents}`,
  };
  const { sort, page } = options;
  const primary =
    sort.dir === "asc"
      ? sql`${sortExpr[sort.key]} asc nulls last`
      : sql`${sortExpr[sort.key]} desc nulls last`;

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        suite,
        tasks: jobCounts.tasks,
        trials: rollup.trials,
        scored: rollup.scored,
        errors: rollup.errors,
        mean_reward: scores.mean_reward,
        mean_cost_cents: scores.mean_cost_cents,
      })
      .from(suite)
      .leftJoin(jobCounts, eq(jobCounts.suiteId, suite.id))
      .leftJoin(rollup, eq(rollup.suiteId, suite.id))
      .leftJoin(scores, eq(scores.suiteId, suite.id))
      .orderBy(primary, desc(suite.startedAt), asc(suite.id))
      .limit(page.per)
      .offset((page.page - 1) * page.per),
    db.select({ total: sql<number>`count(*)::int` }).from(suite),
  ]);
  return {
    total: counted?.total ?? 0,
    rows: rows.map((r) => ({
      ...r.suite,
      tasks: r.tasks ?? 0,
      trials: r.trials ?? 0,
      scored: r.scored ?? 0,
      errors: r.errors ?? 0,
      mean_reward: r.mean_reward == null ? null : Number(r.mean_reward),
      mean_cost_cents:
        r.mean_cost_cents == null ? null : Number(r.mean_cost_cents),
    })),
  };
}

export async function getSuite(id: string): Promise<SuiteRow | undefined> {
  const rows = await getCurrentTransaction()
    .select()
    .from(suite)
    .where(eq(suite.id, id))
    .limit(1);
  return rows[0];
}

export async function listJobs(suite_id: string): Promise<JobRow[]> {
  return getCurrentTransaction()
    .select()
    .from(job)
    .where(eq(job.suiteId, suite_id))
    .orderBy(asc(job.taskName), asc(job.pass), asc(job.id));
}

export async function listTrials(suite_id: string): Promise<TrialRow[]> {
  return getCurrentTransaction()
    .select()
    .from(trial)
    .where(eq(trial.suiteId, suite_id))
    .orderBy(asc(trial.jobId), asc(trial.trialName));
}

export async function listTrialCalls(
  trial_id: string
): Promise<ModelCallRow[]> {
  return getCurrentTransaction()
    .select()
    .from(modelCall)
    .where(eq(modelCall.trialId, trial_id))
    .orderBy(asc(modelCall.sequence));
}

/** Everything the suite page needs, in three reads. */
export async function loadSuite(
  id: string
): Promise<
  { suite: SuiteRow; jobs: JobRow[]; trials: TrialRow[] } | undefined
> {
  const row = await getSuite(id);
  if (!row) return undefined;
  const [jobs, trials] = await Promise.all([listJobs(id), listTrials(id)]);
  return { suite: row, jobs, trials };
}

/** Everything the trial page needs: the trial, its job and suite, its calls. */
export async function loadTrial(
  id: string
): Promise<
  | { trial: TrialRow; job: JobRow; suite: SuiteRow; calls: ModelCallRow[] }
  | undefined
> {
  const rows = await getCurrentTransaction()
    .select()
    .from(trial)
    .where(eq(trial.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const [jobs, suites, calls] = await Promise.all([
    getCurrentTransaction()
      .select()
      .from(job)
      .where(eq(job.id, row.jobId))
      .limit(1),
    getCurrentTransaction()
      .select()
      .from(suite)
      .where(eq(suite.id, row.suiteId))
      .limit(1),
    listTrialCalls(id),
  ]);
  const j = jobs[0];
  const s = suites[0];
  if (!j || !s) return undefined;
  return { trial: row, job: j, suite: s, calls };
}
