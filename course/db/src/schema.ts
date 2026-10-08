import type { Provider, Wire } from "@context-cup/shared/provider.js";
// Every table lives here. Add a pgTable export, then run `bin/db generate`
// to write the migration and `bin/db migrate` to apply it.
//
// Properties are named exactly as their columns, in snake_case, so a row in
// code reads the same as a row in psql. (drizzle's casing: "snake_case" in
// drizzle.config.ts and connection.ts then maps each name to itself.)
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  pgView,
  primaryKey,
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
  /** Trials per task (harbor `--n-attempts`); an `--append` may raise it. */
  count: integer().notNull(),
  /** This and the invocation facts below (harbor_sha, github_run_*,
   *  harbor_env) are the first invocation's; a trial an `--append` ran
   *  carries its own. */
  git_sha: text(),
  /** The harbor fork commit the run used (the checkout follows the fork's
   *  main, so this is what makes a run reproducible); null with
   *  HARBOR_DIR=global. */
  harbor_sha: text(),
  /** The driver's code as it ran: `driverFingerprint` over the driver's
   *  package and every package it extends (course/suite/src/fingerprint.ts).
   *  Compared with `driver.fingerprint` to tell a stale run from a current
   *  one; null for runs from before it was recorded. */
  driver_fingerprint: text(),
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
     *  later pass added to make up trials that did not finish (a
     *  `--retry_errors` pass, or an `--append` run, which numbers on from
     *  the suite's last pass). */
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
    /** The job's pass (job.pass). */
    pass: integer().notNull().default(0),
    harbor_env: text().notNull(),
    git_sha: text(),
    harbor_sha: text(),
    driver_fingerprint: text(),
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

/** Every runnable package under drivers/, as `bin/drivers sync` last found it
 *  on main. A driver that leaves the tree is marked removed, never deleted,
 *  so its runs keep a row to point at. */
export const driver = pgTable("driver", {
  /** Its folder name, as `--driver` takes it. */
  name: text().primaryKey(),
  kind: text().notNull().$type<"driver" | "agent">(),
  /** The engine or driver it builds on; null for a root package. */
  extends: text(),
  /** The providers it can drive, resolved through its chain. */
  providers: text().$type<Provider>().array().notNull(),
  description: text(),
  /** See `suite.driver_fingerprint`. */
  fingerprint: text().notNull(),
  /** The commit the sync read it at. */
  git_sha: text(),
  first_seen_at: timestamp({ withTimezone: true }).notNull(),
  /** When a sync last saw its fingerprint change; null when it hasn't
   *  changed since it was first seen. */
  changed_at: timestamp({ withTimezone: true }),
  synced_at: timestamp({ withTimezone: true }).notNull(),
  removed_at: timestamp({ withTimezone: true }),
});

/** The suites the competition is judged on and the target it judges them at,
 *  with what a run needs to count (`ELIGIBILITY` in
 *  course/shared/src/competition.ts). `bin/db migrate` replaces these rows
 *  as a whole after applying migrations, so the rule a deploy states is the
 *  rule the database judges by. */
export const competitionSuite = pgTable("competition_suite", {
  suite_name: text().primaryKey(),
  target_name: text().notNull(),
  provider: text().notNull().$type<Provider>(),
  /** Done trials every task needs. */
  min_done: integer().notNull(),
});

/** The tasks a run of a competition suite must cover. */
export const competitionTask = pgTable(
  "competition_task",
  {
    suite_name: text()
      .notNull()
      .references(() => competitionSuite.suite_name, { onDelete: "cascade" }),
    task_name: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.suite_name, t.task_name] })]
);

/** Every run's totals and score, as the leaderboard scores it: a task is
 *  the mean over its done trials (a reward and no error) in all its jobs, a
 *  run the mean over its tasks. */
export const suiteScore = pgView("suite_score", {
  suite_id: text().notNull(),
  /** Tasks it has jobs for. */
  tasks: integer().notNull(),
  trials: integer().notNull(),
  /** Done trials. */
  scored: integer().notNull(),
  errors: integer().notNull(),
  /** Tasks with at least one done trial. */
  tasks_scored: integer().notNull(),
  mean_reward: doublePrecision(),
  /** Mean over tasks of each task's mean cost; times the task count, the
   *  cost of a full run. */
  mean_cost_cents: doublePrecision(),
  /** The fewest done trials any task has; null with no jobs. */
  min_task_done: integer(),
}).as(sql`
  with task as (
    select j.suite_id, j.task_name,
      count(t.id)::int as trials,
      count(t.id) filter (
        where t.reward is not null and t.error is null
      )::int as done,
      count(t.id) filter (where t.error is not null)::int as errors,
      avg(t.reward) filter (
        where t.reward is not null and t.error is null
      ) as task_reward,
      avg(t.cost_cents) filter (
        where t.reward is not null and t.error is null
      ) as task_cost
    from job j left join trial t on t.job_id = j.id
    group by j.suite_id, j.task_name
  )
  select s.id as suite_id,
    count(task.task_name)::int as tasks,
    coalesce(sum(task.trials), 0)::int as trials,
    coalesce(sum(task.done), 0)::int as scored,
    coalesce(sum(task.errors), 0)::int as errors,
    count(task.task_reward)::int as tasks_scored,
    avg(task.task_reward) as mean_reward,
    avg(task.task_cost) as mean_cost_cents,
    min(task.done) as min_task_done
  from suite s left join task on task.suite_id = s.id
  group by s.id
`);

/** Whether each run counts toward the competition, and the facts that
 *  decide it. This is the competition's eligibility rule (README "Winning"),
 *  read from the `competition_*` tables `bin/db migrate` writes: a run counts
 *  when it is of a competition suite at that suite's target, finished,
 *  covers every task the suite requires, and has at least `min_done` done
 *  trials in each. `on_board` marks the run its driver stands on: its latest
 *  that counts, per suite and target. The site's leaderboard and suites
 *  pages read this, and `driver_status` builds on it. */
export const runEligibility = pgView("run_eligibility", {
  suite_id: text().notNull(),
  suite_name: text().notNull(),
  driver_name: text().notNull(),
  target_name: text().notNull(),
  driver_fingerprint: text(),
  started_at: timestamp({ withTimezone: true }).notNull(),
  finished_at: timestamp({ withTimezone: true }),
  /** The target the competition judges a suite of this name at; null when
   *  the suite isn't a competition suite. */
  competition_target: text(),
  /** Done trials each task needs; null for a suite that isn't judged. */
  min_done: integer(),
  /** Tasks the suite requires, and how many of them this run has no job
   *  for. */
  required_tasks: integer().notNull(),
  missing_tasks: integer().notNull(),
  min_task_done: integer(),
  eligible: boolean().notNull(),
  on_board: boolean().notNull(),
}).as(sql`
  with judged as (
    select s.id as suite_id, s.name as suite_name, s.driver_name,
      s.target_name, s.driver_fingerprint, s.started_at, s.finished_at,
      c.target_name as competition_target,
      c.min_done,
      coalesce(req.required, 0) as required_tasks,
      coalesce(req.missing, 0) as missing_tasks,
      sc.min_task_done,
      coalesce(
        c.target_name = s.target_name
        and s.finished_at is not null
        and coalesce(req.missing, 0) = 0
        and coalesce(sc.min_task_done, 0) >= c.min_done,
        false
      ) as eligible
    from suite s
    join suite_score sc on sc.suite_id = s.id
    left join competition_suite c on c.suite_name = s.name
    left join lateral (
      select count(*)::int as required,
        count(*) filter (
          where not exists (
            select 1 from job j
            where j.suite_id = s.id and j.task_name = ct.task_name
          )
        )::int as missing
      from competition_task ct
      where ct.suite_name = s.name
    ) req on true
  )
  select judged.*,
    eligible and row_number() over (
      partition by driver_name, suite_name, target_name, eligible
      order by started_at desc, suite_id desc
    ) = 1 as on_board
  from judged
`);

export type DriverRunStatus = "current" | "running" | "stale" | "missing";

/** Where each driver stands on each competition suite, one row per
 *  registered driver that can run the suite's target:
 *
 *  - `current`: its standing run (`run_eligibility.on_board`) ran its
 *    present code. A run from before fingerprints were recorded counts as
 *    current unless a sync has since seen the driver change.
 *  - `running`: no current run, but one of its present code is under way
 *    (unfinished and started within GitHub's 6-hour job limit).
 *  - `stale`: it has a standing run, of code it has since changed.
 *  - `missing`: no run that counts.
 *
 *  With the standing run's score, and its latest run of any kind with that
 *  run's eligibility facts, so a run that doesn't count says why. */
export const driverStatus = pgView("driver_status", {
  driver_name: text().notNull(),
  suite_name: text().notNull(),
  target_name: text().notNull(),
  status: text().notNull().$type<DriverRunStatus>(),
  driver_fingerprint: text().notNull(),
  required_tasks: integer().notNull(),
  min_done: integer().notNull(),
  standing_suite_id: text(),
  standing_fingerprint: text(),
  standing_started_at: timestamp({ withTimezone: true }),
  mean_reward: doublePrecision(),
  /** A full run's cost: the mean task cost times the suite's tasks. */
  run_cents: doublePrecision(),
  running_suite_id: text(),
  latest_suite_id: text(),
  latest_started_at: timestamp({ withTimezone: true }),
  latest_finished_at: timestamp({ withTimezone: true }),
  latest_eligible: boolean(),
  latest_missing_tasks: integer(),
  latest_min_task_done: integer(),
}).as(sql`
  select d.name as driver_name, c.suite_name, c.target_name,
    case
      when st.suite_id is not null and (
        st.driver_fingerprint = d.fingerprint
        or (st.driver_fingerprint is null
          and (d.changed_at is null or d.changed_at <= st.started_at))
      ) then 'current'
      when r.suite_id is not null then 'running'
      when st.suite_id is not null then 'stale'
      else 'missing'
    end as status,
    d.fingerprint as driver_fingerprint,
    (select count(*)::int from competition_task ct
      where ct.suite_name = c.suite_name) as required_tasks,
    c.min_done,
    st.suite_id as standing_suite_id,
    st.driver_fingerprint as standing_fingerprint,
    st.started_at as standing_started_at,
    sc.mean_reward,
    sc.mean_cost_cents * (select count(*) from competition_task ct
      where ct.suite_name = c.suite_name) as run_cents,
    r.suite_id as running_suite_id,
    lt.suite_id as latest_suite_id,
    lt.started_at as latest_started_at,
    lt.finished_at as latest_finished_at,
    lt.eligible as latest_eligible,
    lt.missing_tasks as latest_missing_tasks,
    lt.min_task_done as latest_min_task_done
  from driver d
  join competition_suite c on c.provider = any(d.providers)
  left join run_eligibility st
    on st.driver_name = d.name
    and st.suite_name = c.suite_name
    and st.target_name = c.target_name
    and st.on_board
  left join suite_score sc on sc.suite_id = st.suite_id
  left join lateral (
    select e.* from run_eligibility e
    where e.driver_name = d.name
      and e.suite_name = c.suite_name
      and e.target_name = c.target_name
    order by e.started_at desc, e.suite_id desc
    limit 1
  ) lt on true
  left join lateral (
    select e.suite_id from run_eligibility e
    where e.driver_name = d.name
      and e.suite_name = c.suite_name
      and e.target_name = c.target_name
      and e.finished_at is null
      and e.started_at > now() - interval '7 hours'
      and e.driver_fingerprint = d.fingerprint
    order by e.started_at desc, e.suite_id desc
    limit 1
  ) r on true
  where d.removed_at is null
`);
