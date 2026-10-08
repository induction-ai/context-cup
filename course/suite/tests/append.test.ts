import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { suite, trial } from "@context-cup/db/schema.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { eq } from "drizzle-orm";
import {
  appendLaunch,
  assertSameTarget,
  loadAppendBase,
  type StoredSuite,
} from "../src/append.ts";
import { ingestJob, insertJob, parseJob } from "../src/ingest.ts";
import { shortfallRuns } from "../src/retry.ts";
import { scoredTrials } from "../src/scoring.ts";
import { FIXTURE_JOBS_DIR, sampleRun, sampleTargets } from "./helpers.ts";

const SUITE = {
  id: "s_app",
  name: "smoke_tau",
  key_file: "suites/smoke_tau.json",
  driver_name: "base_passthrough",
  target_name: "gpt-5.5@medium",
  provider: "openai" as const,
  model: "gpt-5.5",
  reasoning_effort: "medium",
  count: 3,
  git_sha: "aaa",
  harbor_env: "daytona",
  github_run_id: "1",
  log_dir: "/tmp/s_app",
  started_at: new Date("2026-09-25T20:00:00Z"),
  finished_at: new Date("2026-09-25T21:00:00Z"),
};

function stored(overrides: Partial<StoredSuite> = {}): StoredSuite {
  return {
    harbor_sha: null,
    driver_fingerprint: null,
    github_run_attempt: null,
    github_repository: null,
    ...SUITE,
    ...overrides,
  };
}

const result = (job_id: string) => ({
  job_id,
  exit_code: 0,
  ok: true,
  error: null,
  started_at: new Date("2026-09-25T20:01:00Z"),
  finished_at: new Date("2026-09-25T20:02:00Z"),
  log_file: "/tmp/x.log",
});

describe("appendLaunch", () => {
  it("takes the suite’s driver, target, and count", async () => {
    expect(appendLaunch(stored(), { suite_key: "smoke_tau" })).toEqual({
      driver: "base_passthrough",
      target: "gpt-5.5@medium",
      count: 3,
    });
  });

  it("refuses a flag that disagrees with the suite", async () => {
    expect(() => appendLaunch(stored(), { suite_key: "tau_banking" })).toThrow(
      /ran suite smoke_tau, not tau_banking/
    );
    expect(() =>
      appendLaunch(stored(), { suite_key: "smoke_tau", driver: "base_python" })
    ).toThrow(/ran driver base_passthrough/);
    expect(() =>
      appendLaunch(stored(), {
        suite_key: "smoke_tau",
        target: "claude-sonnet-4-6",
      })
    ).toThrow(/ran target gpt-5.5@medium/);
  });

  it("lets --count raise the count, never lower it", async () => {
    expect(
      appendLaunch(stored(), { suite_key: "smoke_tau", count: 5 }).count
    ).toBe(5);
    expect(() =>
      appendLaunch(stored(), { suite_key: "smoke_tau", count: 2 })
    ).toThrow(/can only raise it/);
  });
});

describe("assertSameTarget", () => {
  it("passes when targets.json still maps the name to the same model", async () => {
    expect(() =>
      assertSameTarget(stored(), sampleTargets()["gpt-5.5@medium"]!)
    ).not.toThrow();
  });

  it("refuses a target whose model changed since", async () => {
    expect(() =>
      assertSameTarget(stored(), {
        provider: "openai",
        model: "gpt-5.6",
        reasoning_effort: "medium",
      })
    ).toThrow(/is now openai\/gpt-5.6@medium/);
  });
});

describe("loadAppendBase", () => {
  it("reads the suite’s tasks, next pass, and stored trials", async () => {
    const db = getCurrentTransaction();
    await db.insert(suite).values(SUITE);
    // The fixture job holds one done trial and two errored ones.
    for (const [job_id, pass] of [
      ["j_app0", 0],
      ["j_app1", 1],
    ] as const) {
      await insertJob({
        job_id,
        suite_id: SUITE.id,
        run: sampleRun({ count: 3 }),
        target: { provider: "openai", model: "gpt-5.5" },
        concurrency: 1,
        command: "harbor run …",
        jobs_dir: `/tmp/s_app/${job_id}/harbor`,
        pass,
      });
    }
    await ingestJob(
      SUITE.id,
      "j_app0",
      result("j_app0"),
      parseJob(FIXTURE_JOBS_DIR, "j_fixture")
    );

    const base = await loadAppendBase(SUITE.id);
    expect(base.suite.count).toBe(3);
    expect(base.task_names).toEqual(["banking_001"]);
    expect(base.next_pass).toBe(2);
    const trials = base.trials_by_task.get("banking_001")!;
    expect(trials).toHaveLength(3);
    expect(scoredTrials(trials)).toHaveLength(1);

    // What the append then runs: the two trials the task still owes.
    const done = new Map([["banking_001", scoredTrials(trials).length]]);
    const owed = shortfallRuns([sampleRun({ count: 3 })], done);
    expect(owed.map((r) => r.count)).toEqual([2]);
  });

  it("refuses a suite that does not exist", async () => {
    await expect(loadAppendBase("s_nope")).rejects.toThrow(/no suite s_nope/);
  });
});

describe("ingestJob with invocation facts", () => {
  it("records the appending invocation, not the suite’s first", async () => {
    const db = getCurrentTransaction();
    await db.insert(suite).values(SUITE);
    await insertJob({
      job_id: "j_app2",
      suite_id: SUITE.id,
      run: sampleRun(),
      target: { provider: "openai", model: "gpt-5.5" },
      concurrency: 1,
      command: "harbor run …",
      jobs_dir: "/tmp/s_app/j_app2/harbor",
      pass: 2,
    });
    await ingestJob(
      SUITE.id,
      "j_app2",
      result("j_app2"),
      parseJob(FIXTURE_JOBS_DIR, "j_fixture"),
      {
        harbor_env: "docker",
        git_sha: "bbb",
        harbor_sha: "hhh",
        driver_fingerprint: "v1:appended",
        github_run_id: "2",
        github_run_attempt: 1,
        github_repository: "induction-ai/context-cup",
      }
    );
    const rows = await db
      .select()
      .from(trial)
      .where(eq(trial.job_id, "j_app2"));
    expect(rows[0]).toMatchObject({
      pass: 2,
      harbor_env: "docker",
      git_sha: "bbb",
      driver_fingerprint: "v1:appended",
      github_run_id: "2",
    });
  });
});
