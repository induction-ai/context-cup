import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, modelCall, suite, trial } from "@context-cup/db/schema.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { listSuites, loadSuite, loadTrial } from "../src/lib/queries.ts";

async function seed() {
  const db = getCurrentTransaction();
  await db.insert(suite).values({
    id: "s_site",
    name: "sample",
    keyFile: "suites/x.json",
    driverName: "base_passthrough",
    targetName: "gpt-5.5@medium",
    provider: "openai",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    count: 1,
    gitSha: "abcdef0123",
    githubRunId: "77",
    githubRunAttempt: 1,
    githubRepository: "o/r",
    harborEnv: "docker",
    logDir: "/tmp/s_site",
    startedAt: new Date("2026-09-22T10:00:00Z"),
    finishedAt: new Date("2026-09-22T10:05:00Z"),
  });
  await db.insert(job).values({
    id: "j_site",
    suiteId: "s_site",
    taskName: "banking_001",
    runner: "tau3",
    driverName: "base_passthrough",
    targetName: "gpt-5.5@medium",
    provider: "openai",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    count: 1,
    concurrency: 1,
    command: "harbor run …",
    status: "done",
    jobsDir: "/tmp/s_site/j_site/harbor",
  });
  await db.insert(trial).values([
    {
      id: "t_1",
      suiteId: "s_site",
      jobId: "j_site",
      trialName: "banking-001__a",
      reward: 1,
      stopReason: "user_stop",
      turns: 3,
      envToolCalls: 2,
      durationMs: 4000,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 50,
      modelCalls: 2,
      costCents: 4.5,
      trialDir: "/tmp/t_1",
    },
    {
      id: "t_2",
      suiteId: "s_site",
      jobId: "j_site",
      trialName: "banking-001__b",
      error: "boom",
      trialDir: "/tmp/t_2",
    },
  ]);
  await db.insert(modelCall).values([
    {
      suiteId: "s_site",
      jobId: "j_site",
      trialId: "t_1",
      turnId: "001_aaaaaa",
      sequence: 1,
      provider: "openai",
      model: "gpt-5.5",
      wire: "responses",
      purpose: "turn",
      inputTokens: 400,
      outputTokens: 20,
      costCents: 2,
    },
    {
      suiteId: "s_site",
      jobId: "j_site",
      trialId: "t_1",
      turnId: "002_bbbbbb",
      sequence: 2,
      provider: "openai",
      model: "gpt-5.5",
      wire: "responses",
      purpose: "turn",
      inputTokens: 600,
      cachedInputTokens: 400,
      outputTokens: 30,
      costCents: 2.5,
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
    expect(s.githubRunId).toBe("77");
  });

  it("scores a retry pass into its task, not as another task", async () => {
    await seed();
    const db = getCurrentTransaction();
    const base = {
      suiteId: "s_site",
      runner: "tau3",
      driverName: "base_passthrough",
      targetName: "gpt-5.5@medium",
      provider: "openai" as const,
      model: "gpt-5.5",
      count: 1,
      concurrency: 1,
      command: "harbor run …",
      status: "done" as const,
      jobsDir: "/tmp/s_site/harbor",
    };
    await db.insert(job).values([
      { ...base, id: "j_retry", taskName: "banking_001", pass: 1 },
      { ...base, id: "j_other", taskName: "banking_002" },
    ]);
    await db.insert(trial).values([
      {
        id: "t_retry",
        suiteId: "s_site",
        jobId: "j_retry",
        trialName: "banking-001__c",
        reward: 0,
        costCents: 1.5,
        trialDir: "/tmp/t_retry",
      },
      {
        id: "t_other",
        suiteId: "s_site",
        jobId: "j_other",
        trialName: "banking-002__a",
        reward: 1,
        costCents: 3,
        trialDir: "/tmp/t_other",
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
    expect(data?.suite.driverName).toBe("base_passthrough");
    expect(data?.jobs.map((j) => j.taskName)).toEqual(["banking_001"]);
    expect(data?.trials.map((t) => t.trialName)).toEqual([
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
    expect(data?.trial.trialName).toBe("banking-001__a");
    expect(data?.job.taskName).toBe("banking_001");
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
        keyFile: "suites/smoke_tau.json",
        driverName: "base_passthrough",
        targetName: "gpt-5.5@medium",
        provider: "openai",
        model: "gpt-5.5",
        count: i + 1,
        harborEnv: "docker",
        logDir: `/tmp/s_page_${i}`,
        startedAt: new Date(2026, 0, 1 + i),
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
