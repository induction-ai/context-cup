import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, modelCall, suite, trial } from "@context-cup/db/schema.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  countTrials,
  listSuites,
  loadBoard,
  loadSuite,
  loadTrial,
} from "../src/lib/queries.ts";

/** What every trial row carries from its job and suite (the trial table is
 *  denormalized). */
function facts(task_name: string, pass = 0) {
  return {
    suite_name: "sample",
    task_name,
    runner: "tau3",
    driver_name: "base_passthrough",
    target_name: "gpt-5.5@medium",
    provider: "openai" as const,
    model: "gpt-5.5",
    reasoning_effort: "medium",
    pass,
    harbor_env: "docker",
  };
}

async function seed() {
  const db = getCurrentTransaction();
  await db.insert(suite).values({
    id: "s_site",
    name: "sample",
    key_file: "suites/x.json",
    driver_name: "base_passthrough",
    target_name: "gpt-5.5@medium",
    provider: "openai",
    model: "gpt-5.5",
    reasoning_effort: "medium",
    count: 1,
    git_sha: "abcdef0123",
    github_run_id: "77",
    github_run_attempt: 1,
    github_repository: "o/r",
    harbor_env: "docker",
    log_dir: "/tmp/s_site",
    started_at: new Date("2026-09-22T10:00:00Z"),
    finished_at: new Date("2026-09-22T10:05:00Z"),
  });
  await db.insert(job).values({
    id: "j_site",
    suite_id: "s_site",
    task_name: "banking_001",
    runner: "tau3",
    driver_name: "base_passthrough",
    target_name: "gpt-5.5@medium",
    provider: "openai",
    model: "gpt-5.5",
    reasoning_effort: "medium",
    count: 1,
    concurrency: 1,
    command: "harbor run …",
    status: "done",
    jobs_dir: "/tmp/s_site/j_site/harbor",
  });
  await db.insert(trial).values([
    {
      id: "t_1",
      ...facts("banking_001"),
      suite_id: "s_site",
      job_id: "j_site",
      trial_name: "banking-001__a",
      reward: 1,
      stop_reason: "user_stop",
      turns: 3,
      env_tool_calls: 2,
      duration_ms: 4000,
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 50,
      model_calls: 2,
      cost_cents: 4.5,
      trial_dir: "/tmp/t_1",
    },
    {
      id: "t_2",
      ...facts("banking_001"),
      suite_id: "s_site",
      job_id: "j_site",
      trial_name: "banking-001__b",
      error: "boom",
      trial_dir: "/tmp/t_2",
    },
  ]);
  await db.insert(modelCall).values([
    {
      suite_id: "s_site",
      job_id: "j_site",
      trial_id: "t_1",
      turn_id: "001_aaaaaa",
      sequence: 1,
      provider: "openai",
      model: "gpt-5.5",
      wire: "responses",
      purpose: "turn",
      input_tokens: 400,
      output_tokens: 20,
      cost_cents: 2,
    },
    {
      suite_id: "s_site",
      job_id: "j_site",
      trial_id: "t_1",
      turn_id: "002_bbbbbb",
      sequence: 2,
      provider: "openai",
      model: "gpt-5.5",
      wire: "responses",
      purpose: "turn",
      input_tokens: 600,
      cached_input_tokens: 400,
      output_tokens: 30,
      cost_cents: 2.5,
    },
  ]);
}

describe("queries", () => {
  it("lists suites newest first with trial rollups", async () => {
    await seed();
    const { rows, total } = await listSuites({
      sort: { key: "started", dir: "desc" },
      page: { page: 1, per: 50 },
    });
    const s = rows.find((r) => r.id === "s_site")!;
    expect(rows[0]?.id).toBe("s_site");
    expect(total).toBeGreaterThanOrEqual(1);
    expect(s.tasks).toBe(1);
    expect(s.trials).toBe(2);
    expect(s.scored).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.mean_reward).toBe(1);
    expect(s.mean_cost_cents).toBeCloseTo(4.5, 6);
    expect(s.github_run_id).toBe("77");
  });

  it("scores a retry pass into its task, not as another task", async () => {
    await seed();
    const db = getCurrentTransaction();
    const base = {
      suite_id: "s_site",
      runner: "tau3",
      driver_name: "base_passthrough",
      target_name: "gpt-5.5@medium",
      provider: "openai" as const,
      model: "gpt-5.5",
      count: 1,
      concurrency: 1,
      command: "harbor run …",
      status: "done" as const,
      jobs_dir: "/tmp/s_site/harbor",
    };
    await db.insert(job).values([
      { ...base, id: "j_retry", task_name: "banking_001", pass: 1 },
      { ...base, id: "j_other", task_name: "banking_002" },
    ]);
    await db.insert(trial).values([
      {
        id: "t_retry",
        ...facts("banking_001", 1),
        suite_id: "s_site",
        job_id: "j_retry",
        trial_name: "banking-001__c",
        reward: 0,
        cost_cents: 1.5,
        trial_dir: "/tmp/t_retry",
      },
      {
        id: "t_other",
        ...facts("banking_002"),
        suite_id: "s_site",
        job_id: "j_other",
        trial_name: "banking-002__a",
        reward: 1,
        cost_cents: 3,
        trial_dir: "/tmp/t_other",
      },
    ]);
    const { rows } = await listSuites({
      sort: { key: "started", dir: "desc" },
      page: { page: 1, per: 50 },
    });
    const s = rows.find((r) => r.id === "s_site")!;
    expect(s.tasks).toBe(2);
    // banking_001 is (1 + 0) / 2 over both its jobs, banking_002 is 1; a
    // job-weighted mean would be 2/3.
    expect(s.mean_reward).toBeCloseTo(0.75, 6);
    expect(s.mean_cost_cents).toBeCloseTo((3 + 3) / 2, 6);
    const data = await loadSuite("s_site");
    expect(data?.jobs.map((j) => [j.id, j.pass])).toEqual([
      ["j_site", 0],
      ["j_retry", 1],
      ["j_other", 0],
    ]);
  });

  it("loads a suite with its jobs and trials, and nothing for an unknown id", async () => {
    await seed();
    const data = await loadSuite("s_site");
    expect(data?.suite.driver_name).toBe("base_passthrough");
    expect(data?.jobs.map((j) => j.task_name)).toEqual(["banking_001"]);
    expect(data?.trials.map((t) => t.trial_name)).toEqual([
      "banking-001__a",
      "banking-001__b",
    ]);
    expect(await loadSuite("s_nope")).toBeUndefined();
  });

  it("loads a trial with its job, suite, and calls in order", async () => {
    await seed();
    const listed = await loadSuite("s_site");
    const first = listed!.trials[0]!;
    const data = await loadTrial(first.id);
    expect(data?.trial.trial_name).toBe("banking-001__a");
    expect(data?.job.task_name).toBe("banking_001");
    expect(data?.suite.id).toBe("s_site");
    expect(data?.calls.map((c) => c.sequence)).toEqual(
      [...(data?.calls ?? [])].map((c) => c.sequence).sort((a, b) => a - b)
    );
    expect(await loadTrial("t_nope")).toBeUndefined();
  });

  it("counts every trial", async () => {
    expect(await countTrials()).toBe(0);
    await seed();
    expect(await countTrials()).toBe(2);
  });
});

describe("listSuites paging and sorting", () => {
  async function seedMore(n: number) {
    const db = getCurrentTransaction();
    for (let i = 0; i < n; i++) {
      await db.insert(suite).values({
        id: `s_page_${i}`,
        name: "smoke_tau",
        key_file: "suites/smoke_tau.json",
        driver_name: "base_passthrough",
        target_name: "gpt-5.5@medium",
        provider: "openai",
        model: "gpt-5.5",
        count: i + 1,
        harbor_env: "docker",
        log_dir: `/tmp/s_page_${i}`,
        started_at: new Date(2026, 0, 1 + i),
      });
    }
  }

  it("slices pages in the database and sorts by any column with nulls last", async () => {
    await seed();
    await seedMore(3);
    const p1 = await listSuites({
      sort: { key: "count", dir: "desc" },
      page: { page: 1, per: 2 },
    });
    const p2 = await listSuites({
      sort: { key: "count", dir: "desc" },
      page: { page: 2, per: 2 },
    });
    expect(p1.total).toBe(4);
    expect(p1.rows.map((r) => r.count)).toEqual([3, 2]);
    expect(p2.rows.map((r) => r.count)).toEqual([1, 1]);
    const byReward = await listSuites({
      sort: { key: "reward", dir: "desc" },
      page: { page: 1, per: 10 },
    });
    // The seeded suite is the only one with a score; the unscored ones follow.
    expect(byReward.rows[0]?.id).toBe("s_site");
    expect(byReward.rows.slice(1).every((r) => r.mean_reward === null)).toBe(
      true
    );
  });
});

describe("leaderboard queries", () => {
  const rules = { min_done: 2, tasks: { board: ["t1", "t2"] } };

  /** One run of suite "board" by `driver` at gpt-5.5@medium. `tasks` maps
   *  each task to its trials' rewards per pass (null: an errored trial). */
  async function run(
    id: string,
    driver: string,
    opts: {
      count?: number;
      started: string;
      finished?: boolean;
      tasks: Record<string, Array<Array<number | null>>>;
      cost?: number;
    }
  ) {
    const db = getCurrentTransaction();
    const target = {
      driver_name: driver,
      target_name: "gpt-5.5@medium",
      provider: "openai" as const,
      model: "gpt-5.5",
    };
    await db.insert(suite).values({
      id,
      name: "board",
      key_file: "suites/board.json",
      ...target,
      count: opts.count ?? 3,
      harbor_env: "docker",
      log_dir: `/tmp/${id}`,
      started_at: new Date(opts.started),
      finished_at: opts.finished === false ? null : new Date(opts.started),
    });
    for (const [task_name, passes] of Object.entries(opts.tasks)) {
      for (const [pass, rewards] of passes.entries()) {
        const job_id = `${id}_${task_name}_${pass}`;
        await db.insert(job).values({
          id: job_id,
          suite_id: id,
          task_name,
          runner: "tau3",
          ...target,
          count: opts.count ?? 3,
          pass,
          concurrency: 1,
          command: "harbor run …",
          status: "done",
          jobs_dir: `/tmp/${id}/harbor`,
        });
        for (const [n, reward] of rewards.entries()) {
          await db.insert(trial).values({
            id: `${job_id}_${n}`,
            suite_id: id,
            job_id,
            trial_name: `${task_name}__${pass}_${n}`,
            suite_name: "board",
            task_name,
            runner: "tau3",
            ...target,
            pass,
            harbor_env: "docker",
            reward,
            error: reward == null ? "boom" : null,
            cost_cents: reward == null ? null : (opts.cost ?? 10),
            trial_dir: `/tmp/${job_id}_${n}`,
          });
        }
      }
    }
  }

  it("stands each driver on its latest finished run with enough done trials", async () => {
    // a's oldest run is its only eligible one: the next two each have a task
    // with one done trial, the newest has not finished.
    await run("s_a_old", "a", {
      started: "2026-09-01T00:00:00Z",
      tasks: { t1: [[1, 1, 0]], t2: [[1, 0]] },
      cost: 20,
    });
    await run("s_a_thin", "a", {
      started: "2026-09-02T00:00:00Z",
      tasks: { t1: [[1, 1, 1]], t2: [[1, null, null]] },
    });
    await run("s_a_one", "a", {
      count: 1,
      started: "2026-09-03T00:00:00Z",
      tasks: { t1: [[1]], t2: [[1]] },
    });
    await run("s_a_running", "a", {
      finished: false,
      started: "2026-09-04T00:00:00Z",
      tasks: { t1: [[1, 1, 1]], t2: [[1, 1, 1]] },
    });
    // Eligible, but s_a_old is newer: superseded.
    await run("s_a_older", "a", {
      started: "2026-08-31T00:00:00Z",
      tasks: { t1: [[0, 0, 0]], t2: [[0, 0, 0]] },
    });
    // b's t1 reaches two done trials only with its retry pass; a count of 2
    // is enough.
    await run("s_b", "b", {
      count: 2,
      started: "2026-09-02T00:00:00Z",
      tasks: { t1: [[1, null], [0]], t2: [[1, 1]] },
    });
    // b's newest run is thick enough but skips t2: not a full run.
    await run("s_b_partial", "b", {
      started: "2026-09-05T00:00:00Z",
      tasks: { t1: [[1, 1, 1]] },
    });
    // c never has an eligible run.
    await run("s_c", "c", {
      started: "2026-09-02T00:00:00Z",
      tasks: { t1: [[1, null, null]], t2: [[1, 1, 1]] },
    });

    const { tasks, entries } = await loadBoard(
      "board",
      "gpt-5.5@medium",
      rules
    );
    expect(tasks).toBe(2);
    expect(entries.map((e) => [e.driver_name, e.suite_id])).toEqual([
      ["a", "s_a_old"],
      ["b", "s_b"],
    ]);
    const [a, b] = entries;
    expect(a).toMatchObject({ trials: 5, scored: 5, errors: 0 });
    expect(a!.tasks_scored).toBe(2);
    // t1 is 2/3, t2 is 1/2; the run is their mean.
    expect(a!.mean_reward).toBeCloseTo((2 / 3 + 1 / 2) / 2, 6);
    expect(a!.mean_cost_cents).toBeCloseTo(20, 6);
    expect(b).toMatchObject({ trials: 5, scored: 4, errors: 1 });
    // t1 is (1 + 0) / 2 over both passes, t2 is 1.
    expect(b!.mean_reward).toBeCloseTo(0.75, 6);
    expect((await loadBoard("board", "gpt-5.5@low", rules)).entries).toEqual(
      []
    );

    // The suites index says which run is each driver's entry.
    const { rows } = await listSuites({
      sort: { key: "suite", dir: "asc" },
      page: { page: 1, per: 200 },
      rules,
    });
    expect(
      Object.fromEntries(
        rows
          .filter((r) => r.name === "board")
          .map((r) => [r.id, [r.min_task_done, r.missing_tasks, r.on_board]])
      )
    ).toEqual({
      s_a_older: [3, 0, false],
      s_a_old: [2, 0, true],
      s_a_thin: [1, 0, false],
      s_a_one: [1, 0, false],
      s_a_running: [3, 0, false],
      s_b: [2, 0, true],
      s_b_partial: [3, 1, false],
      s_c: [1, 0, false],
    });
  });
});
