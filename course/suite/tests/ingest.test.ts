import path from "node:path";
import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, modelCall, suite, trial } from "@context-cup/db/schema.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { eq } from "drizzle-orm";
import {
  ingestJob,
  insertJob,
  parseJob,
  parseTrial,
  readCallLog,
} from "../src/ingest.ts";
import { resultsTable, suiteTotals, summarizeCell } from "../src/results.ts";
import { FIXTURE_CALLS, FIXTURE_JOBS_DIR, sampleRun } from "./helpers.ts";

describe("parseTrial", () => {
  it("reads reward, usage, summary, and prices the calls", async () => {
    const t = parseTrial(
      path.join(FIXTURE_JOBS_DIR, "j_fixture", "banking-001__abc1234"),
      readCallLog(FIXTURE_CALLS).get("banking-001__abc1234")
    );
    expect(t.reward).toBe(1);
    expect(t.score_reason).toBe("all 3 actions matched");
    expect(t.error).toBeNull();
    expect(t.stop_reason).toBe("user_stop");
    expect(t.turns).toBe(2);
    expect(t.env_tool_calls).toBe(3);
    expect(t.duration_ms).toBe(150_000);
    expect(t.totals).toEqual({
      input: 12000,
      cached_input: 8000,
      cache_write_input: 0,
      output: 500,
      reasoning_output: 100,
    });
    expect(t.calls.map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(t.calls[2]?.service_tier ?? null).toBeNull();
    const expected =
      ((8000 * 0.5 + 2000 * 5 + 300 * 30) / 1e6 + (2000 * 5 + 200 * 30) / 1e6) *
      100;
    expect(t.cost_cents).toBeCloseTo(expected, 6);
  });

  it("prices an unnamed model as unknown and counts the call", async () => {
    const calls = readCallLog(FIXTURE_CALLS).get("banking-001__zzz0000")!;
    const t = parseTrial(
      path.join(FIXTURE_JOBS_DIR, "j_fixture", "banking-001__abc1234"),
      calls
    );
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.model).toBe("?");
    expect(t.calls[0]?.cost_cents).toBeNull();
    expect(t.cost_cents).toBeNull();
  });

  it("records an errored trial with no usage", async () => {
    const t = parseTrial(
      path.join(FIXTURE_JOBS_DIR, "j_fixture", "banking-001__def5678")
    );
    expect(t.reward).toBeNull();
    expect(t.error).toBe("RuntimeError: turn 003_aaaaaa failed twice");
    expect(t.calls).toEqual([]);
    expect(t.cost_cents).toBeNull();
  });
});

describe("parseJob", () => {
  it("discovers trials from result.json and adds placeholders from the job's exception stats", async () => {
    const trials = parseJob(FIXTURE_JOBS_DIR, "j_fixture", FIXTURE_CALLS);
    expect(trials.map((t) => t.trial_name)).toEqual([
      "banking-001__abc1234",
      "banking-001__def5678",
      "banking-001__ghi9012",
    ]);
    expect(trials[2]?.error).toBe(
      "EnvironmentStartTimeoutError: no trial result written"
    );
    expect(parseJob(FIXTURE_JOBS_DIR, "missing", FIXTURE_CALLS)).toEqual([]);
  });
});

describe("ingestJob", () => {
  it("writes suite, job, trial, and model call rows", async () => {
    const db = getCurrentTransaction();
    await db.insert(suite).values({
      id: "s_test",
      name: "sample",
      keyFile: "suites/x.json",
      driverName: "base_passthrough",
      targetName: "gpt-5.5@medium",
      provider: "openai",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      count: 2,
      harborEnv: "docker",
      logDir: "/tmp/s_test",
      startedAt: new Date(),
    });
    const run = sampleRun();
    await insertJob({
      job_id: "j_test",
      suite_id: "s_test",
      run,
      target: {
        provider: "openai",
        model: "gpt-5.5",
        reasoning_effort: "medium",
      },
      concurrency: 2,
      command: "harbor run …",
      jobs_dir: "/tmp/s_test/j_test/harbor",
    });
    const trials = parseJob(FIXTURE_JOBS_DIR, "j_fixture", FIXTURE_CALLS);
    const started_at = new Date("2026-09-22T10:00:00Z");
    await ingestJob(
      "s_test",
      "j_test",
      {
        job_id: "j_test",
        exit_code: 0,
        ok: true,
        error: null,
        started_at,
        finished_at: new Date(),
        log_file: "/tmp/x",
      },
      trials
    );

    const jobs = await db.select().from(job).where(eq(job.id, "j_test"));
    expect(jobs[0]?.status).toBe("done");
    expect(jobs[0]?.driverName).toBe("base_passthrough");
    const rows = await db.select().from(trial).where(eq(trial.jobId, "j_test"));
    expect(rows).toHaveLength(3);
    const scored = rows.find((r) => r.trialName === "banking-001__abc1234")!;
    expect(scored.reward).toBe(1);
    expect(scored.inputTokens).toBe(12000);
    expect(scored.modelCalls).toBe(3);
    expect(scored.costCents).toBeGreaterThan(0);
    const calls = await db
      .select()
      .from(modelCall)
      .where(eq(modelCall.trialId, scored.id));
    expect(calls.map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(calls[0]?.turnId).toBe("001_k3v9xq");

    const cell = summarizeCell(run, trials);
    expect(cell).toMatchObject({ n: 3, scored: 1, errors: 2, mean_reward: 1 });
    expect(resultsTable([cell])).toContain("banking_001");
    expect(resultsTable([cell])).toContain("ALL");
    // The suite is the mean of its cells: two tasks at 1 and 0 score 0.5,
    // whatever their trial counts.
    const other = {
      ...cell,
      task_name: "banking_002",
      mean_reward: 0,
      n: 5,
      scored: 5,
    };
    expect(suiteTotals([cell, other])).toEqual({
      score: 0.5,
      mean_cost_cents: cell.mean_cost_cents,
    });
    expect(suiteTotals([])).toEqual({ score: null, mean_cost_cents: null });
  });
});

describe("agent-kind trials", () => {
  it("take turns and tool calls from harbor's trajectory and tokens from the proxy log", async () => {
    const trials = parseJob(
      FIXTURE_JOBS_DIR,
      "j_agent",
      path.join(FIXTURE_JOBS_DIR, "..", "calls_agent.jsonl")
    );
    expect(trials).toHaveLength(1);
    const t = trials[0]!;
    expect(t.reward).toBe(1);
    expect(t.stop_reason).toBeNull();
    expect(t.turns).toBe(3);
    expect(t.env_tool_calls).toBe(3);
    expect(t.calls.map((c) => c.turn_id)).toEqual([null, null, null]);
    expect(t.totals.input).toBe(8000);
    // The rejected probe (401, no body) billed nothing: cost 0, not unpriced.
    expect(t.calls[2]?.cost_cents).toBe(0);
    expect(t.cost_cents).not.toBeNull();
  });
});
