/** Every read the pages make. Plain functions returning rows; the pages do
 *  the rendering and `aggregate.ts` does the arithmetic. */
import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, modelCall, suite, trial } from "@context-cup/db/schema.js";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { Page, Sort } from "./sort";
import { ELIGIBILITY, type Entry } from "./standings";

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
  /** The fewest done trials any task has (null with no jobs), and whether
   *  this run is its driver's leaderboard entry; `standings.ts` turns them
   *  into the leaderboard column. */
  min_task_done: number | null;
  on_board: boolean;
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
  rules?: Eligibility;
}): Promise<{ rows: SuiteSummary[]; total: number }> {
  const db = getCurrentTransaction();
  const rollup = db
    .select({
      suite_id: trial.suite_id,
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
    .groupBy(trial.suite_id)
    .as("rollup");
  // A task's means over its done trials in all its jobs, then the suite's
  // mean over its tasks.
  const done = sql`${trial.reward} is not null and ${trial.error} is null`;
  const taskMeans = db
    .select({
      suite_id: trial.suite_id,
      task_name: job.task_name,
      task_reward: sql<
        number | null
      >`avg(${trial.reward}) filter (where ${done})`.as("task_reward"),
      task_cost: sql<
        number | null
      >`avg(${trial.cost_cents}) filter (where ${done})`.as("task_cost"),
    })
    .from(trial)
    .innerJoin(job, eq(job.id, trial.job_id))
    .groupBy(trial.suite_id, job.task_name)
    .as("task_means");
  const scores = db
    .select({
      suite_id: taskMeans.suite_id,
      mean_reward: sql<number | null>`avg(${taskMeans.task_reward})`.as(
        "mean_reward"
      ),
      mean_cost_cents: sql<number | null>`avg(${taskMeans.task_cost})`.as(
        "mean_cost_cents"
      ),
    })
    .from(taskMeans)
    .groupBy(taskMeans.suite_id)
    .as("scores");
  const jobCounts = db
    .select({
      suite_id: job.suite_id,
      tasks: sql<number>`count(distinct ${job.task_name})::int`.as("tasks"),
    })
    .from(job)
    .groupBy(job.suite_id)
    .as("job_counts");

  const sortExpr: Record<SuiteSortKey, SQL> = {
    suite: sql`${suite.id}`,
    name: sql`${suite.name}`,
    driver: sql`${suite.driver_name}`,
    target: sql`${suite.target_name}`,
    tasks: sql`${jobCounts.tasks}`,
    count: sql`${suite.count}`,
    started: sql`${suite.started_at}`,
    duration: sql`${suite.finished_at} - ${suite.started_at}`,
    trials: sql`${rollup.trials}`,
    done: sql`${rollup.scored}`,
    errors: sql`${rollup.errors}`,
    reward: sql`${scores.mean_reward}`,
    cost: sql`${scores.mean_cost_cents}`,
  };
  const { sort, page, rules = ELIGIBILITY } = options;
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
        min_task_done: minTaskDone(suite),
        on_board: onBoard(rules),
      })
      .from(suite)
      .leftJoin(jobCounts, eq(jobCounts.suite_id, suite.id))
      .leftJoin(rollup, eq(rollup.suite_id, suite.id))
      .leftJoin(scores, eq(scores.suite_id, suite.id))
      .orderBy(primary, desc(suite.started_at), asc(suite.id))
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
      min_task_done: r.min_task_done == null ? null : Number(r.min_task_done),
      on_board: Boolean(r.on_board),
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
    .where(eq(job.suite_id, suite_id))
    .orderBy(asc(job.task_name), asc(job.pass), asc(job.id));
}

export async function listTrials(suite_id: string): Promise<TrialRow[]> {
  return getCurrentTransaction()
    .select()
    .from(trial)
    .where(eq(trial.suite_id, suite_id))
    .orderBy(asc(trial.job_id), asc(trial.trial_name));
}

export async function listTrialCalls(
  trial_id: string
): Promise<ModelCallRow[]> {
  return getCurrentTransaction()
    .select()
    .from(modelCall)
    .where(eq(modelCall.trial_id, trial_id))
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
      .where(eq(job.id, row.job_id))
      .limit(1),
    getCurrentTransaction()
      .select()
      .from(suite)
      .where(eq(suite.id, row.suite_id))
      .limit(1),
    listTrialCalls(id),
  ]);
  const j = jobs[0];
  const s = suites[0];
  if (!j || !s) return undefined;
  return { trial: row, job: j, suite: s, calls };
}

/** What a run needs to stand on a leaderboard. */
export type Eligibility = {
  /** Attempts per task (the suite's `count`). */
  min_count: number;
  /** Done trials (a reward and no error) every task needs, retry passes
   *  included. */
  min_done: number;
};

/** The fewest done trials (a reward and no error) any of a run's tasks
 *  has, retry passes included; null for a run with no jobs. */
/** The suite columns the eligibility rule reads, from `suite` or an alias. */
type SuiteCols = Record<"id" | "count" | "finished_at", AnyPgColumn>;

function minTaskDone(s: SuiteCols): SQL<number | null> {
  return sql<number | null>`(
    select min(task_done.done) from (
      select count(${trial.id}) filter (
        where ${trial.reward} is not null and ${trial.error} is null
      ) as done
      from ${job} left join ${trial} on ${trial.job_id} = ${job.id}
      where ${job.suite_id} = ${s.id}
      group by ${job.task_name}
    ) as task_done
  )`;
}

/** A run that can stand on a leaderboard: finished, at least `min_count`
 *  attempts per task, and at least `min_done` done trials in every one of
 *  its tasks. `standings.ts` states the same rule over a run's facts. */
function eligible(
  { min_count, min_done }: Eligibility,
  s: SuiteCols = suite
): SQL {
  return sql`(${s.count} >= ${min_count}
    and ${s.finished_at} is not null
    and coalesce(${minTaskDone(s)}, 0) >= ${min_done})`;
}

/** The run is its driver's latest eligible one for its suite name and
 *  target: the run that driver's leaderboard entry comes from. */
function onBoard(rules: Eligibility): SQL<boolean> {
  const newer = alias(suite, "newer");
  return sql<boolean>`(${eligible(rules)} and not exists (
    select 1 from ${suite} ${sql.identifier("newer")}
    where ${newer.name} = ${suite.name}
      and ${newer.target_name} = ${suite.target_name}
      and ${newer.driver_name} = ${suite.driver_name}
      and (${newer.started_at}, ${newer.id}) > (${suite.started_at}, ${suite.id})
      and ${eligible(rules, newer)}
  ))`;
}

/** Every driver's entry on one board, each from its own most recent
 *  eligible run of the suite at the target (earlier runs do not count):
 *  that run's task means over its done trials, retry passes included, then
 *  the mean over tasks, as a suite is scored. `tasks` is how many tasks the
 *  suite has covered in any run, the count a full benchmark run's cost
 *  multiplies by. */
export async function loadBoard(
  suite_name: string,
  target_name: string,
  rules: Eligibility
): Promise<{ tasks: number; entries: Entry[] }> {
  const db = getCurrentTransaction();
  const latest = db
    .selectDistinctOn([suite.driver_name], {
      suite_id: sql<string>`${suite.id}`.as("latest_suite_id"),
      suite_started_at: sql<Date>`${suite.started_at}`.as("latest_started_at"),
    })
    .from(suite)
    .where(
      and(
        eq(suite.name, suite_name),
        eq(suite.target_name, target_name),
        eligible(rules)
      )
    )
    .orderBy(suite.driver_name, desc(suite.started_at), desc(suite.id))
    .as("latest");
  const done = sql`${trial.reward} is not null and ${trial.error} is null`;
  const taskMeans = db
    .select({
      suite_id: trial.suite_id,
      task_name: trial.task_name,
      task_reward: sql<
        number | null
      >`avg(${trial.reward}) filter (where ${done})`.as("task_reward"),
      task_cost: sql<
        number | null
      >`avg(${trial.cost_cents}) filter (where ${done})`.as("task_cost"),
    })
    .from(trial)
    .innerJoin(latest, eq(latest.suite_id, trial.suite_id))
    .groupBy(trial.suite_id, trial.task_name)
    .as("task_means");
  const scores = db
    .select({
      suite_id: taskMeans.suite_id,
      tasks_scored: sql<number>`count(${taskMeans.task_reward})::int`.as(
        "tasks_scored"
      ),
      mean_reward: sql<number | null>`avg(${taskMeans.task_reward})`.as(
        "mean_reward"
      ),
      mean_cost_cents: sql<number | null>`avg(${taskMeans.task_cost})`.as(
        "mean_cost_cents"
      ),
    })
    .from(taskMeans)
    .groupBy(taskMeans.suite_id)
    .as("scores");
  const rollup = db
    .select({
      suite_id: trial.suite_id,
      trials: sql<number>`count(*)::int`.as("trials"),
      scored: sql<number>`count(*) filter (where ${done})::int`.as("scored"),
      errors:
        sql<number>`count(*) filter (where ${trial.error} is not null)::int`.as(
          "errors"
        ),
    })
    .from(trial)
    .innerJoin(latest, eq(latest.suite_id, trial.suite_id))
    .groupBy(trial.suite_id)
    .as("rollup");

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        driver_name: suite.driver_name,
        suite_id: suite.id,
        suite_started_at: suite.started_at,
        trials: rollup.trials,
        scored: rollup.scored,
        errors: rollup.errors,
        tasks_scored: scores.tasks_scored,
        mean_reward: scores.mean_reward,
        mean_cost_cents: scores.mean_cost_cents,
      })
      .from(latest)
      .innerJoin(suite, eq(suite.id, latest.suite_id))
      .leftJoin(rollup, eq(rollup.suite_id, latest.suite_id))
      .leftJoin(scores, eq(scores.suite_id, latest.suite_id))
      .orderBy(asc(suite.driver_name)),
    db
      .select({
        tasks: sql<number>`count(distinct ${trial.task_name})::int`,
      })
      .from(trial)
      .where(eq(trial.suite_name, suite_name)),
  ]);
  return {
    tasks: counted?.tasks ?? 0,
    entries: rows.map((r) => ({
      ...r,
      trials: r.trials ?? 0,
      scored: r.scored ?? 0,
      errors: r.errors ?? 0,
      tasks_scored: r.tasks_scored ?? 0,
      mean_reward: r.mean_reward == null ? null : Number(r.mean_reward),
      mean_cost_cents:
        r.mean_cost_cents == null ? null : Number(r.mean_cost_cents),
    })),
  };
}

/** Trials run across every suite, for the home page. */
export async function countTrials(): Promise<number> {
  const db = getCurrentTransaction();
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(trial);
  return row?.n ?? 0;
}
