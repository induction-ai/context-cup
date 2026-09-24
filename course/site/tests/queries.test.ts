import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, modelCall, suite, trial } from "@context-cup/db/schema.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { listSuites, loadSuite, loadTrial } from "../src/lib/queries.ts";

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
