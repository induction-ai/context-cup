import {
  writeCompetition,
  type CompetitionFacts,
} from "@context-cup/db/competition.js";
import { getCurrentTransaction } from "@context-cup/db/connection.js";
import {
  driver,
  driverStatus,
  job,
  suite,
  trial,
} from "@context-cup/db/schema.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { asc } from "drizzle-orm";
import { scanDrivers, syncDrivers, type DriverFacts } from "../src/drivers.ts";
import { scanPackages } from "../src/packages.ts";

const T0 = new Date("2026-10-01T00:00:00Z");
const T1 = new Date("2026-10-02T00:00:00Z");
const T2 = new Date("2026-10-03T00:00:00Z");

function facts(name: string, fingerprint: string): DriverFacts {
  return {
    name,
    kind: "driver",
    extends: "python",
    providers: ["openai", "anthropic"],
    description: null,
    fingerprint,
  };
}

const BENCH: CompetitionFacts = {
  suite_name: "bench",
  target_name: "gpt-5.5@medium",
  provider: "openai",
  min_done: 2,
  tasks: ["a", "b"],
};

async function drivers() {
  return getCurrentTransaction()
    .select()
    .from(driver)
    .orderBy(asc(driver.name));
}

describe("syncDrivers", () => {
  it("adds, keeps, changes, removes, and restores", async () => {
    let report = await syncDrivers({
      drivers: [facts("alpha", "fp1"), facts("beta", "fp1")],
      git_sha: "c1",
      now: T0,
    });
    expect(report.added).toEqual(["alpha", "beta"]);
    expect((await drivers()).map((d) => d.changed_at)).toEqual([null, null]);

    report = await syncDrivers({
      drivers: [facts("alpha", "fp2")],
      git_sha: "c2",
      now: T1,
    });
    expect(report).toMatchObject({ changed: ["alpha"], removed: ["beta"] });
    const [alpha, beta] = await drivers();
    expect(alpha).toMatchObject({
      fingerprint: "fp2",
      git_sha: "c2",
      first_seen_at: T0,
      changed_at: T1,
      removed_at: null,
    });
    expect(beta).toMatchObject({ removed_at: T1, fingerprint: "fp1" });

    report = await syncDrivers({
      drivers: [facts("alpha", "fp2"), facts("beta", "fp1")],
      git_sha: "c3",
      now: T2,
    });
    expect(report).toMatchObject({
      unchanged: ["alpha"],
      restored: ["beta"],
      removed: [],
    });
    expect((await drivers())[0]!.changed_at).toEqual(T1);
  });

  it("refuses an empty scan", async () => {
    await expect(syncDrivers({ drivers: [], git_sha: null })).rejects.toThrow(
      /No drivers/
    );
  });

  it("scans the real workspace", async () => {
    const scanned = scanDrivers(scanPackages());
    expect(scanned.map((d) => d.name)).toContain("base_python");
    expect(scanned.every((d) => d.kind !== ("engine" as string))).toBe(true);
  });
});

let seq = 0;

/** A run of `bench` by `driver_name`: one job per task, each with `done`
 *  done trials. */
async function run(options: {
  driver_name: string;
  fingerprint: string | null;
  started_at: Date;
  finished?: boolean;
  done?: number;
  tasks?: string[];
  suite_name?: string;
  target_name?: string;
  reward?: number;
}): Promise<string> {
  const db = getCurrentTransaction();
  const id = `s_${++seq}`;
  const suite_name = options.suite_name ?? "bench";
  const target_name = options.target_name ?? "gpt-5.5@medium";
  await db.insert(suite).values({
    id,
    name: suite_name,
    key_file: `suites/${suite_name}.json`,
    driver_name: options.driver_name,
    target_name,
    provider: "openai",
    model: "gpt-5.5",
    count: 2,
    driver_fingerprint: options.fingerprint,
    harbor_env: "docker",
    log_dir: "/tmp",
    started_at: options.started_at,
    finished_at: options.finished === false ? null : options.started_at,
  });
  for (const task_name of options.tasks ?? ["a", "b"]) {
    const job_id = `j_${++seq}`;
    await db.insert(job).values({
      id: job_id,
      suite_id: id,
      task_name,
      runner: "tau3",
      driver_name: options.driver_name,
      target_name,
      provider: "openai",
      model: "gpt-5.5",
      count: 2,
      concurrency: 1,
      command: "",
      status: "done",
      jobs_dir: "/tmp",
    });
    for (let i = 0; i < (options.done ?? 2); i++) {
      await db.insert(trial).values({
        id: `t_${++seq}`,
        suite_id: id,
        job_id,
        trial_name: `${task_name}_${i}`,
        suite_name,
        task_name,
        runner: "tau3",
        driver_name: options.driver_name,
        target_name,
        provider: "openai",
        model: "gpt-5.5",
        harbor_env: "docker",
        reward: options.reward ?? 1,
        cost_cents: 10,
        trial_dir: "/tmp",
      });
    }
  }
  return id;
}

async function statuses() {
  const rows = await getCurrentTransaction()
    .select()
    .from(driverStatus)
    .orderBy(asc(driverStatus.driver_name));
  return Object.fromEntries(rows.map((r) => [r.driver_name, r]));
}

describe("driver_status", () => {
  async function register(...list: DriverFacts[]) {
    await writeCompetition(getCurrentTransaction(), [BENCH]);
    await syncDrivers({ drivers: list, git_sha: null, now: T0 });
  }

  it("is missing without an eligible run", async () => {
    await register(
      facts("none", "fp"),
      facts("partial", "fp"),
      facts("thin", "fp"),
      facts("unfinished_old", "fp")
    );
    await run({
      driver_name: "partial",
      fingerprint: "fp",
      started_at: T0,
      tasks: ["a"],
    });
    await run({
      driver_name: "thin",
      fingerprint: "fp",
      started_at: T0,
      done: 1,
    });
    // Unfinished, and too long ago to still be running.
    await run({
      driver_name: "unfinished_old",
      fingerprint: "fp",
      started_at: T0,
      finished: false,
    });
    const s = await statuses();
    for (const name of ["none", "partial", "thin", "unfinished_old"]) {
      expect(s[name]).toMatchObject({
        status: "missing",
        standing_suite_id: null,
      });
    }
  });

  it("is current, stale, or running by fingerprint", async () => {
    await register(
      facts("same", "fp"),
      facts("changed", "fp_new"),
      facts("rerunning", "fp_new")
    );
    const same = await run({
      driver_name: "same",
      fingerprint: "fp",
      started_at: T0,
    });
    const old = await run({
      driver_name: "changed",
      fingerprint: "fp_old",
      started_at: T0,
    });
    await run({
      driver_name: "rerunning",
      fingerprint: "fp_old",
      started_at: T0,
    });
    const rerun = await run({
      driver_name: "rerunning",
      fingerprint: "fp_new",
      started_at: new Date(),
      finished: false,
    });
    const s = await statuses();
    expect(s.same).toMatchObject({
      status: "current",
      standing_suite_id: same,
    });
    expect(s.changed).toMatchObject({
      status: "stale",
      standing_suite_id: old,
      standing_fingerprint: "fp_old",
      driver_fingerprint: "fp_new",
    });
    expect(s.rerunning).toMatchObject({
      status: "running",
      running_suite_id: rerun,
    });
  });

  it("stands on the latest eligible run", async () => {
    await register(facts("d", "fp_new"));
    await run({ driver_name: "d", fingerprint: "fp_old", started_at: T0 });
    const latest = await run({
      driver_name: "d",
      fingerprint: "fp_new",
      started_at: T1,
    });
    // Newer, but not eligible.
    await run({
      driver_name: "d",
      fingerprint: "fp_new",
      started_at: T2,
      done: 1,
    });
    expect((await statuses()).d).toMatchObject({
      status: "current",
      standing_suite_id: latest,
    });
  });

  it("counts a run from before fingerprints until the driver changes", async () => {
    await register(facts("legacy", "fp"), facts("edited", "fp"));
    await run({ driver_name: "legacy", fingerprint: null, started_at: T0 });
    await run({ driver_name: "edited", fingerprint: null, started_at: T0 });
    await syncDrivers({
      drivers: [facts("legacy", "fp"), facts("edited", "fp2")],
      git_sha: null,
      now: T1,
    });
    const s = await statuses();
    expect(s.legacy!.status).toBe("current");
    expect(s.edited!.status).toBe("stale");
  });

  it("carries the standing run's score, and why the latest run doesn't count", async () => {
    await register(facts("d", "fp"));
    const standing = await run({
      driver_name: "d",
      fingerprint: "fp",
      started_at: T0,
      reward: 0.5,
    });
    const thin = await run({
      driver_name: "d",
      fingerprint: "fp",
      started_at: T1,
      tasks: ["a"],
      done: 1,
    });
    expect((await statuses()).d).toMatchObject({
      status: "current",
      standing_suite_id: standing,
      mean_reward: 0.5,
      // Ten cents a task, two tasks.
      run_cents: 20,
      required_tasks: 2,
      min_done: 2,
      latest_suite_id: thin,
      latest_eligible: false,
      latest_missing_tasks: 1,
      latest_min_task_done: 1,
    });
  });

  it("only lists drivers that can run the target, and not removed ones", async () => {
    await register(
      { ...facts("gemini_only", "fp"), providers: ["gemini"] },
      facts("gone", "fp")
    );
    await syncDrivers({
      drivers: [{ ...facts("gemini_only", "fp"), providers: ["gemini"] }],
      git_sha: null,
    });
    expect(await statuses()).toEqual({});
  });

  it("ignores runs at another target or of another suite", async () => {
    await register(facts("d", "fp"));
    await run({
      driver_name: "d",
      fingerprint: "fp",
      started_at: T0,
      target_name: "other",
    });
    await run({
      driver_name: "d",
      fingerprint: "fp",
      started_at: T0,
      suite_name: "smoke",
    });
    expect((await statuses()).d!.status).toBe("missing");
  });
});
