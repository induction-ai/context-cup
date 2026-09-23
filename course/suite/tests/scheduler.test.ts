import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  dockerJobCap,
  jobTimeoutMs,
  processQueue,
  type Launched,
  type QueueEntry,
} from "../src/scheduler.ts";
import { sampleRun } from "./helpers.ts";

type Fake = {
  running: string[];
  max: number;
  order: string[];
  resolve: Map<string, () => void>;
};

function fakeLauncher(fake: Fake) {
  return (request: { prefix: string }): Launched => {
    const id = request.prefix.slice(1, -1);
    fake.running.push(id);
    fake.order.push(id);
    fake.max = Math.max(fake.max, fake.running.length);
    let finish!: () => void;
    const done = new Promise<{ exit_code: number | null }>((resolve) => {
      finish = () => {
        fake.running.splice(fake.running.indexOf(id), 1);
        resolve({ exit_code: 0 });
      };
    });
    fake.resolve.set(id, finish);
    return { done, signal: () => finish() };
  };
}

function entry(
  job_id: string,
  overrides: Partial<QueueEntry> = {}
): QueueEntry {
  return {
    job_id,
    run: sampleRun({ count: 1 }),
    env: {},
    concurrency_use: 1,
    uses_docker: true,
    command: {
      argv: ["true"],
      shell: "true",
      env: {},
      env_names: [],
      jobs_dir: "/tmp/x",
      job_name: job_id,
      missing_keys: [],
    },
    ...overrides,
  };
}

const quiet = () => {};

describe("processQueue", () => {
  it("caps docker jobs and drains everything", async () => {
    const fake: Fake = { running: [], max: 0, order: [], resolve: new Map() };
    const queue = ["a", "b", "c", "d"].map((id) => entry(id));
    const running = processQueue(queue, {
      suite_concurrency: 64,
      docker_jobs: 2,
      log_dir: "/tmp",
      launcher: fakeLauncher(fake),
      report: quiet,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.running).toEqual(["a", "b"]);
    fake.resolve.get("a")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.running).toEqual(["b", "c"]);
    for (const id of ["b", "c", "d"]) {
      await new Promise((r) => setTimeout(r, 10));
      fake.resolve.get(id)!();
    }
    const results = await running;
    expect(results.map((r) => r.job_id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake.max).toBe(2);
  });

  it("serialises a task with concurrency 1 but lets other tasks skip ahead", async () => {
    const fake: Fake = { running: [], max: 0, order: [], resolve: new Map() };
    const serial = sampleRun({
      task_name: "t1",
      task: {
        runner: "tau3",
        tau3: { customer: "banking_001" },
        concurrency: 1,
      },
    });
    const other = sampleRun({ task_name: "t2" });
    const queue = [
      entry("a", { run: serial }),
      entry("b", { run: serial }),
      entry("c", { run: other }),
    ];
    const running = processQueue(queue, {
      suite_concurrency: 64,
      docker_jobs: 0,
      log_dir: "/tmp",
      launcher: fakeLauncher(fake),
      report: quiet,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.running).toEqual(["a", "c"]);
    fake.resolve.get("a")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.running).toEqual(["c", "b"]);
    fake.resolve.get("c")!();
    fake.resolve.get("b")!();
    await running;
    expect(fake.order).toEqual(["a", "c", "b"]);
  });

  it("caps a target's concurrency across every task, merged with the task caps", async () => {
    const fake: Fake = { running: [], max: 0, order: [], resolve: new Map() };
    const throttled = {
      provider: "openai" as const,
      model: "m",
      concurrency: 1,
    };
    const queue = [
      entry("a", { run: sampleRun({ task_name: "t1", target: throttled }) }),
      entry("b", { run: sampleRun({ task_name: "t2", target: throttled }) }),
    ];
    const running = processQueue(queue, {
      suite_concurrency: 64,
      docker_jobs: 0,
      log_dir: "/tmp",
      launcher: fakeLauncher(fake),
      report: quiet,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.running).toEqual(["a"]);
    fake.resolve.get("a")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.running).toEqual(["b"]);
    fake.resolve.get("b")!();
    await running;
    expect(fake.order).toEqual(["a", "b"]);
  });

  it("stops admitting after abort and reports cancelled", async () => {
    const fake: Fake = { running: [], max: 0, order: [], resolve: new Map() };
    const controller = new AbortController();
    const queue = [entry("a"), entry("b")];
    const running = processQueue(queue, {
      suite_concurrency: 1,
      docker_jobs: 0,
      log_dir: "/tmp",
      launcher: fakeLauncher(fake),
      report: quiet,
      signal: controller.signal,
      kill_grace_ms: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const results = await running;
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBe("cancelled");
    expect(fake.order).toEqual(["a"]);
  });

  it("fails a queue entry that can never fit", async () => {
    const fake: Fake = { running: [], max: 0, order: [], resolve: new Map() };
    await expect(
      processQueue([entry("a", { concurrency_use: 4 })], {
        suite_concurrency: 2,
        docker_jobs: 0,
        log_dir: "/tmp",
        launcher: fakeLauncher(fake),
        report: quiet,
      })
    ).rejects.toThrow("can never run");
  });

  it("derives caps and timeouts", async () => {
    expect(dockerJobCap("arm64", {})).toBe(2);
    expect(dockerJobCap("x64", {})).toBe(4);
    expect(dockerJobCap("x64", { SUITE_DOCKER_COUNT: "6" })).toBe(6);
    expect(jobTimeoutMs(sampleRun({ count: 4, timeout_minutes: 40 }), 2)).toBe(
      70 * 2 * 60_000
    );
    expect(jobTimeoutMs(sampleRun({ count: 1, timeout_minutes: 10 }), 1)).toBe(
      40 * 60_000
    );
  });
});

describe("failures in the finish hook", () => {
  it("mark the job failed, are reported, and reach the results", async () => {
    const fake: Fake = { running: [], max: 0, order: [], resolve: new Map() };
    const lines: string[] = [];
    const running = processQueue([entry("a")], {
      suite_concurrency: 4,
      docker_jobs: 0,
      log_dir: "/tmp",
      launcher: fakeLauncher(fake),
      report: (line) => lines.push(line),
      on_finished: async () => {
        throw new Error("ingest: bad usage.json");
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    fake.resolve.get("a")!();
    const results = await running;
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("ingest: bad usage.json");
    expect(
      lines.some((l) => l.includes("failed (ingest: bad usage.json)"))
    ).toBe(true);
  });
});
