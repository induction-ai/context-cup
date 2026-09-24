import type { Provider, Wire } from "@context-cup/shared/provider.js";
// Every table lives here. Add a pgTable export, then run `bin/db generate`
// to write the migration and `bin/db migrate` to apply it.
//
// Properties are named exactly as their columns, in snake_case, so a row in
// code reads the same as a row in psql. (drizzle's casing: "snake_case" in
// drizzle.config.ts and connection.ts then maps each name to itself.)
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** One `bin/suite` invocation. */
/** One `bin/suite` run: a suite file's tasks, driven by one driver against
 *  one target. */
export const suite = pgTable("suite", {
  id: text().primaryKey(),
  name: text().notNull(),
  key_file: text().notNull(),
  driver_name: text().notNull(),
  target_name: text().notNull(),
  provider: text().notNull().$type<Provider>(),
  model: text().notNull(),
  reasoning_effort: text(),
  /** Trials per task (harbor `--n-attempts`). */
  count: integer().notNull(),
  git_sha: text(),
  /** The harbor fork commit the run used (the checkout follows the fork's
   *  main, so this is what makes a run reproducible); null with
   *  HARBOR_DIR=global. */
  harbor_sha: text(),
  /** Set when bin/suite runs inside GitHub Actions, from GITHUB_RUN_ID,
   *  GITHUB_RUN_ATTEMPT, and GITHUB_REPOSITORY; null for local runs. */
  github_run_id: text(),
  github_run_attempt: integer(),
  github_repository: text(),
  harbor_env: text().notNull(),
  log_dir: text().notNull(),
  started_at: timestamp({ withTimezone: true }).notNull(),
  finished_at: timestamp({ withTimezone: true }),
});

export type JobStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "timed_out"
  | "cancelled";

/** One `harbor run` for a (task, driver, target) cell of the suite matrix. */
export const job = pgTable(
  "job",
  {
    id: text().primaryKey(),
    suite_id: text()
      .notNull()
      .references(() => suite.id),
    task_name: text().notNull(),
    runner: text().notNull(),
    driver_name: text().notNull(),
    target_name: text().notNull(),
    provider: text().notNull().$type<Provider>(),
    model: text().notNull(),
    reasoning_effort: text(),
    /** Trials harbor runs for this job (`--n-attempts`). */
    count: integer().notNull(),
    /** 0 for the suite's first run of the task; n for the job the nth
     *  `--retry_errors` pass added to make up trials that did not finish. */
    pass: integer().notNull().default(0),
    concurrency: integer().notNull(),
    command: text().notNull(),
    status: text().notNull().$type<JobStatus>(),
    error: text(),
    exit_code: integer(),
    jobs_dir: text().notNull(),
    started_at: timestamp({ withTimezone: true }),
    finished_at: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.suite_id)]
);

/** One harbor trial: a single attempt at a task by a driver on a target.
 *
 *  Fully denormalized: a trial row carries every fact about the trial itself,
 *  copied from its job and suite when it is stored (what ran: suite, task,
 *  benchmark, driver, target, pass; and where: harbor env, commits, CI run),
 *  so any question about trials is answered without a join. `job` and
 *  `suite` keep the bookkeeping of their own runs (status, command, paths,
 *  timestamps). A fact added to either that describes the trial is added
 *  here too. */
export const trial = pgTable(
  "trial",
  {
    id: text().primaryKey(),
    suite_id: text()
      .notNull()
      .references(() => suite.id),
    job_id: text()
      .notNull()
      .references(() => job.id),
    trial_name: text().notNull(),
    /** The suite file's name (suite.name). */
    suite_name: text().notNull(),
    task_name: text().notNull(),
    /** The benchmark runner: `tau3` or `toolathlon`. */
    runner: text().notNull(),
    driver_name: text().notNull(),
    target_name: text().notNull(),
    provider: text().notNull().$type<Provider>(),
    model: text().notNull(),
    reasoning_effort: text(),
    /** The job's `--retry_errors` pass (job.pass). */
    pass: integer().notNull().default(0),
    harbor_env: text().notNull(),
    git_sha: text(),
    harbor_sha: text(),
    github_run_id: text(),
    github_run_attempt: integer(),
    github_repository: text(),
    /** The verifier's reward, null when the trial errored before grading. */
    reward: doublePrecision(),
    score_reason: text(),
    error: text(),
    stop_reason: text(),
    turns: integer(),
    env_tool_calls: integer(),
    duration_ms: integer(),
    input_tokens: integer().notNull().default(0),
    cached_input_tokens: integer().notNull().default(0),
    cache_write_input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    reasoning_output_tokens: integer().notNull().default(0),
    model_calls: integer().notNull().default(0),
    cost_cents: doublePrecision(),
    trial_dir: text().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.suite_id),
    index().on(t.job_id),
    index().on(t.driver_name),
    index().on(t.task_name),
  ]
);

/** One model call a driver made, as reported in a turn's output.json. */
export const modelCall = pgTable(
  "model_call",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    suite_id: text()
      .notNull()
      .references(() => suite.id),
    job_id: text()
      .notNull()
      .references(() => job.id),
    trial_id: text()
      .notNull()
      .references(() => trial.id),
    turn_id: text().notNull(),
    /** Position of the call within the trial, across turns. */
    sequence: integer().notNull(),
    /** The provider family the call was billed under; see model_call.host for the endpoint. */
    provider: text().notNull().$type<Provider>(),
    /** The endpoint host the call actually went to. */
    host: text().notNull().default(""),
    model: text().notNull(),
    wire: text().notNull().$type<Wire>(),
    purpose: text(),
    input_tokens: integer().notNull().default(0),
    cached_input_tokens: integer().notNull().default(0),
    cache_write_input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    reasoning_output_tokens: integer().notNull().default(0),
    duration_ms: integer(),
    service_tier: text(),
    cost_cents: doublePrecision(),
    /** Made during a turn attempt the runner discarded (an empty reply);
     *  kept for the record, left out of the trial's usage and cost. */
    discarded: boolean().notNull().default(false),
  },
  (t) => [index().on(t.suite_id), index().on(t.job_id), index().on(t.trial_id)]
);
