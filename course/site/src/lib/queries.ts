/** Every read the pages make. Plain functions returning rows; the pages do
 *  the rendering and `aggregate.ts` does the arithmetic. */
import { getCurrentTransaction } from "@context-cup/db/connection.js";
import {
  job,
  modelCall,
  runEligibility,
  suite,
  suiteScore,
  trial,
} from "@context-cup/db/schema.js";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Page, Sort } from "./sort";
import type { Entry } from "./standings";

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
  /** Its eligibility facts, from the `run_eligibility` view; `standings.ts`
   *  turns them into the leaderboard column. */
  competition_target: string | null;
  min_done: number | null;
  required_tasks: number;
  /** Tasks of its suite this run never ran. */
  missing_tasks: number;
  /** The fewest done trials any task has (null with no jobs). */
  min_task_done: number | null;
  eligible: boolean;
  /** Whether this run is its driver's leaderboard entry. */
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

/** One page of suites, sorted in the database so the slice is right. Scores
 *  come from the `suite_score` view and eligibility from `run_eligibility`
 *  (course/db/src/schema.ts). */
export async function listSuites(options: {
  sort: Sort<SuiteSortKey>;
  page: Page;
}): Promise<{ rows: SuiteSummary[]; total: number }> {
  const db = getCurrentTransaction();
  const sortExpr: Record<SuiteSortKey, SQL> = {
    suite: sql`${suite.id}`,
    name: sql`${suite.name}`,
    driver: sql`${suite.driver_name}`,
    target: sql`${suite.target_name}`,
    tasks: sql`${suiteScore.tasks}`,
    count: sql`${suite.count}`,
    started: sql`${suite.started_at}`,
    duration: sql`${suite.finished_at} - ${suite.started_at}`,
    trials: sql`${suiteScore.trials}`,
    done: sql`${suiteScore.scored}`,
    errors: sql`${suiteScore.errors}`,
    reward: sql`${suiteScore.mean_reward}`,
    cost: sql`${suiteScore.mean_cost_cents}`,
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
        tasks: suiteScore.tasks,
        trials: suiteScore.trials,
        scored: suiteScore.scored,
        errors: suiteScore.errors,
        mean_reward: suiteScore.mean_reward,
        mean_cost_cents: suiteScore.mean_cost_cents,
        competition_target: runEligibility.competition_target,
        min_done: runEligibility.min_done,
        required_tasks: runEligibility.required_tasks,
        missing_tasks: runEligibility.missing_tasks,
        min_task_done: runEligibility.min_task_done,
        eligible: runEligibility.eligible,
        on_board: runEligibility.on_board,
      })
      .from(suite)
      .innerJoin(suiteScore, eq(suiteScore.suite_id, suite.id))
      .innerJoin(runEligibility, eq(runEligibility.suite_id, suite.id))
      .orderBy(primary, desc(suite.started_at), asc(suite.id))
      .limit(page.per)
      .offset((page.page - 1) * page.per),
    db.select({ total: sql<number>`count(*)::int` }).from(suite),
  ]);
  return {
    total: counted?.total ?? 0,
    rows: rows.map((r) => ({
      ...r.suite,
      tasks: r.tasks,
      trials: r.trials,
      scored: r.scored,
      errors: r.errors,
      mean_reward: r.mean_reward == null ? null : Number(r.mean_reward),
      mean_cost_cents:
        r.mean_cost_cents == null ? null : Number(r.mean_cost_cents),
      competition_target: r.competition_target,
      min_done: r.min_done,
      required_tasks: Number(r.required_tasks),
      missing_tasks: Number(r.missing_tasks),
      min_task_done: r.min_task_done == null ? null : Number(r.min_task_done),
      eligible: Boolean(r.eligible),
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

/** Every driver's entry on one board: its run that `run_eligibility` puts
 *  on the board (its most recent eligible run of the suite at the target;
 *  earlier runs do not count), scored as `suite_score` scores a suite.
 *  `tasks` is how many tasks the suite has covered in any run, the count a
 *  full benchmark run's cost multiplies by. */
export async function loadBoard(
  suite_name: string,
  target_name: string
): Promise<{ tasks: number; entries: Entry[] }> {
  const db = getCurrentTransaction();
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        driver_name: runEligibility.driver_name,
        suite_id: runEligibility.suite_id,
        suite_started_at: runEligibility.started_at,
        trials: suiteScore.trials,
        scored: suiteScore.scored,
        errors: suiteScore.errors,
        tasks_scored: suiteScore.tasks_scored,
        mean_reward: suiteScore.mean_reward,
        mean_cost_cents: suiteScore.mean_cost_cents,
      })
      .from(runEligibility)
      .innerJoin(suiteScore, eq(suiteScore.suite_id, runEligibility.suite_id))
      .where(
        and(
          eq(runEligibility.suite_name, suite_name),
          eq(runEligibility.target_name, target_name),
          eq(runEligibility.on_board, true)
        )
      )
      .orderBy(asc(runEligibility.driver_name)),
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
