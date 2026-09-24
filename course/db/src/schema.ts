import type { Provider, Wire } from "@context-cup/shared/provider.js";
// Every table lives here. Add a pgTable export, then run `bin/db generate`
// to write the migration and `bin/db migrate` to apply it.
//
// Column names are derived from property names with casing: "snake_case"
// (see drizzle.config.ts and connection.ts), so write camelCase properties.
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
  keyFile: text().notNull(),
  driverName: text().notNull(),
  targetName: text().notNull(),
  provider: text().notNull().$type<Provider>(),
  model: text().notNull(),
  reasoningEffort: text(),
  /** Trials per task (harbor `--n-attempts`). */
  count: integer().notNull(),
  gitSha: text(),
  /** The harbor fork commit the run used (the checkout follows the fork's
   *  main, so this is what makes a run reproducible); null with
   *  HARBOR_DIR=global. */
  harborSha: text(),
  /** Set when bin/suite runs inside GitHub Actions, from GITHUB_RUN_ID,
   *  GITHUB_RUN_ATTEMPT, and GITHUB_REPOSITORY; null for local runs. */
  githubRunId: text(),
  githubRunAttempt: integer(),
  githubRepository: text(),
  harborEnv: text().notNull(),
  logDir: text().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  finishedAt: timestamp({ withTimezone: true }),
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
    suiteId: text()
      .notNull()
      .references(() => suite.id),
    taskName: text().notNull(),
    runner: text().notNull(),
    driverName: text().notNull(),
    targetName: text().notNull(),
    provider: text().notNull().$type<Provider>(),
    model: text().notNull(),
    reasoningEffort: text(),
    /** Trials harbor runs for this job (`--n-attempts`). */
    count: integer().notNull(),
    /** 0 for the suite's first run of the task; n for the job the nth
     *  `--retry_errors` pass added to make up trials that did not finish. */
    pass: integer().notNull().default(0),
    concurrency: integer().notNull(),
    command: text().notNull(),
    status: text().notNull().$type<JobStatus>(),
    error: text(),
    exitCode: integer(),
    jobsDir: text().notNull(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.suiteId)]
);

/** One harbor trial: a single attempt at a task by a driver on a target. */
export const trial = pgTable(
  "trial",
  {
    id: text().primaryKey(),
    suiteId: text()
      .notNull()
      .references(() => suite.id),
    jobId: text()
      .notNull()
      .references(() => job.id),
    trialName: text().notNull(),
    /** The verifier's reward, null when the trial errored before grading. */
    reward: doublePrecision(),
    scoreReason: text(),
    error: text(),
    stopReason: text(),
    turns: integer(),
    envToolCalls: integer(),
    durationMs: integer(),
    inputTokens: integer().notNull().default(0),
    cachedInputTokens: integer().notNull().default(0),
    cacheWriteInputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    reasoningOutputTokens: integer().notNull().default(0),
    modelCalls: integer().notNull().default(0),
    costCents: doublePrecision(),
    trialDir: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.suiteId), index().on(t.jobId)]
);

/** One model call a driver made, as reported in a turn's output.json. */
export const modelCall = pgTable(
  "model_call",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    suiteId: text()
      .notNull()
      .references(() => suite.id),
    jobId: text()
      .notNull()
      .references(() => job.id),
    trialId: text()
      .notNull()
      .references(() => trial.id),
    turnId: text().notNull(),
    /** Position of the call within the trial, across turns. */
    sequence: integer().notNull(),
    /** The provider family the call was billed under; see model_call.host for the endpoint. */
    provider: text().notNull().$type<Provider>(),
    /** The endpoint host the call actually went to. */
    host: text().notNull().default(""),
    model: text().notNull(),
    wire: text().notNull().$type<Wire>(),
    purpose: text(),
    inputTokens: integer().notNull().default(0),
    cachedInputTokens: integer().notNull().default(0),
    cacheWriteInputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    reasoningOutputTokens: integer().notNull().default(0),
    durationMs: integer(),
    serviceTier: text(),
    costCents: doublePrecision(),
    /** Made during a turn attempt the runner discarded (an empty reply);
     *  kept for the record, left out of the trial's usage and cost. */
    discarded: boolean().notNull().default(false),
  },
  (t) => [index().on(t.suiteId), index().on(t.jobId), index().on(t.trialId)]
);
