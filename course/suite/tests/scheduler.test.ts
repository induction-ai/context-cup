import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@context-cup/shared/test_helpers/index.js";
import { Pool } from "pg";
import {
  dockerJobCap,
  processQueue,
  type Launched,
  type QueueEntry,
  type SchedulerOptions,
} from "../src/scheduler.ts";
import { HOLD_TABLE, SharedBudgets } from "../src/shared_budgets.ts";
import { sampleRun } from "./helpers.ts";

type Fake = {
  running: string[];
  max: number;
  order: string[];
  resolve: Map<string, () => void>;
};

function newFake(): Fake {
  return { running: [], max: 0, order: [], resolve: new Map() };
}

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

/** A task capped at one trial at a time, as the toolathlon tasks that act
 *  on live accounts are. */
const serial = sampleRun({
  task_name: "t1",
  task: {
    runner: "tau3",
    tau3: { customer: "banking_001" },
    concurrency: 1,
  },
});
const serial_claim = { key: "tau3/task:t1", capacity: 1, weight: 1 };

const database_url = process.env.DATABASE_URL!;
const db = new Pool({ connectionString: database_url });
/** This process's view of the shared budgets, opened per test. */
let budgets: SharedBudgets;
/** Another machine running a suite at the same time. */
let other_machine: SharedBudgets;

beforeEach(async () => {
  await db.query(`DELETE FROM ${HOLD_TABLE}`);
  budgets = await SharedBudgets.open({
    invocation_id: "scheduler_test",
    database_url,
    holder: "brian",
    report: quiet,
  });
  other_machine = await SharedBudgets.open({
    invocation_id: "other_machine",
    database_url,
    holder: "alice",
    report: quiet,
  });
});

afterEach(async () => {
  await budgets.close();
  await other_machine.close();
});

afterAll(async () => {
  await db.end();
});

function options(
  fake: Fake,
  overrides: Partial<SchedulerOptions> = {}
): SchedulerOptions {
  return {
    suite_concurrency: 64,
    docker_jobs: 0,
    log_dir: "/tmp",
    launcher: fakeLauncher(fake),
    report: quiet,
    budgets,
    poll_ms: 50,
    ...overrides,
  };
}

/** Admission goes through the database, so the queue settles a few
 *  milliseconds after a job starts or finishes. */
const settled = (check: () => void) =>
  vi.waitFor(check, { timeout: 3_000, interval: 5 });

describe("processQueue", () => {
  it("caps docker jobs and drains everything", async () => {
    const fake = newFake();
    const queue = ["a", "b", "c", "d"].map((id) => entry(id));
    const running = processQueue(queue, options(fake, { docker_jobs: 2 }));
    await settled(() => expect(fake.running).toEqual(["a", "b"]));
    fake.resolve.get("a")!();
    await settled(() => expect(fake.running).toEqual(["b", "c"]));
    for (const id of ["b", "c", "d"]) {
      await settled(() => expect(fake.resolve.has(id)).toBe(true));
      fake.resolve.get(id)!();
    }
    const results = await running;
    expect(results.map((r) => r.job_id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake.max).toBe(2);
  });

  it("serialises a task with concurrency 1 but lets other tasks skip ahead", async () => {
    const fake = newFake();
    const other = sampleRun({ task_name: "t2" });
    const queue = [
      entry("a", { run: serial }),
      entry("b", { run: serial }),
      entry("c", { run: other }),
    ];
    const lines: string[] = [];
    const running = processQueue(
      queue,
      options(fake, { report: (line) => lines.push(line) })
    );
    await settled(() => expect(fake.running).toEqual(["a", "c"]));
    fake.resolve.get("a")!();
    await settled(() => expect(fake.running).toEqual(["c", "b"]));
    fake.resolve.get("c")!();
    fake.resolve.get("b")!();
    await running;
    expect(fake.order).toEqual(["a", "c", "b"]);
    // A budget this process fills itself is nothing to wait on.
    expect(lines.some((l) => l.includes("waiting"))).toBe(false);
  });

  it("caps a target's concurrency across every task, merged with the task caps", async () => {
    const fake = newFake();
    const throttled = {
      provider: "openai" as const,
      model: "m",
      concurrency: 1,
    };
    const queue = [
      entry("a", { run: sampleRun({ task_name: "t1", target: throttled }) }),
      entry("b", { run: sampleRun({ task_name: "t2", target: throttled }) }),
    ];
    const running = processQueue(queue, options(fake));
    await settled(() => expect(fake.running).toEqual(["a"]));
    fake.resolve.get("a")!();
    await settled(() => expect(fake.running).toEqual(["b"]));
    fake.resolve.get("b")!();
    await running;
    expect(fake.order).toEqual(["a", "b"]);
  });

  it("waits for a task budget another machine holds", async () => {
    const fake = newFake();
    await other_machine.acquire("j_remote", [serial_claim]);
    const lines: string[] = [];
    let finished = false;
    const results = processQueue(
      [entry("a", { run: serial })],
      options(fake, { report: (line) => lines.push(line) })
    ).then((r) => {
      finished = true;
      return r;
    });
    await settled(() =>
      expect(lines).toContainEqual(
        "[a] waiting: tau3/task:t1 1/1 in use by alice (j_remote)"
      )
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(finished).toBe(false);
    expect(fake.running).toEqual([]);
    // Logged once, however many polls it waits.
    expect(lines.filter((l) => l.includes("waiting"))).toHaveLength(1);

    await other_machine.release("j_remote");
    await settled(() => expect(fake.running).toEqual(["a"]));
    expect(lines).toContain("[a] budget free, starting");
    fake.resolve.get("a")!();
    expect((await results).map((r) => r.ok)).toEqual([true]);
  });

  it("holds a budget for other machines only while the job runs", async () => {
    const fake = newFake();
    const running = processQueue([entry("a", { run: serial })], options(fake));
    await settled(() => expect(fake.running).toEqual(["a"]));
    expect(await other_machine.acquire("j_remote", [serial_claim])).toEqual({
      admitted: false,
      blocked: [
        {
          key: "tau3/task:t1",
          capacity: 1,
          in_use: 1,
          holds: [
            {
              holder: "brian",
              invocation_id: "scheduler_test",
              job_id: "a",
              weight: 1,
            },
          ],
        },
      ],
    });
    fake.resolve.get("a")!();
    await running;
    expect(await other_machine.acquire("j_remote", [serial_claim])).toEqual({
      admitted: true,
    });
  });

  it("keeps going when the shared database is briefly unreachable", async () => {
    const fake = newFake();
    vi.spyOn(budgets, "acquire").mockRejectedValueOnce(
      new Error("connection terminated")
    );
    const lines: string[] = [];
    const running = processQueue(
      [entry("a"), entry("b")],
      options(fake, { report: (line) => lines.push(line) })
    );
    await settled(() => expect(fake.running).toEqual(["a", "b"]));
    fake.resolve.get("a")!();
    fake.resolve.get("b")!();
    const results = await running;
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(lines).toContain(
      "shared budgets unreachable, retrying in 0.05s: connection terminated"
    );
  });

  it("fails a job whose budget is lost before it starts", async () => {
    const fake = newFake();
    const [result] = await processQueue(
      [entry("a", { run: serial })],
      options(fake, {
        // The machine went quiet past the expiry while setting the job up;
        // another one took the task meanwhile.
        on_started: async () => {
          await db.query(
            `UPDATE ${HOLD_TABLE} SET heartbeat_at = now() - interval '1 hour'
             WHERE invocation_id = 'scheduler_test'`
          );
          await other_machine.acquire("j_remote", [serial_claim]);
          await budgets.heartbeat();
        },
      })
    );
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe(
      "lost shared budget: tau3/task:t1 1/1 in use by alice (j_remote); not started"
    );
    expect(fake.order).toEqual([]);
  });

  it("stops a running job whose budget another machine took while this one was unreachable", async () => {
    const fake = newFake();
    const killed: string[] = [];
    const running = processQueue(
      [entry("a", { run: serial })],
      options(fake, {
        kill_grace_ms: 5,
        on_killed: async (e, reason) => {
          killed.push(`${e.job_id} ${reason}`);
        },
      })
    );
    await settled(() => expect(fake.running).toEqual(["a"]));
    await db.query(
      `UPDATE ${HOLD_TABLE} SET heartbeat_at = now() - interval '1 hour'
       WHERE invocation_id = 'scheduler_test'`
    );
    expect(await other_machine.acquire("j_remote", [serial_claim])).toEqual({
      admitted: true,
    });

    await budgets.heartbeat();
    const [result] = await running;
    expect(result?.ok).toBe(false);
    expect(result?.exit_code).toBeNull();
    expect(result?.error).toBe(
      "lost shared budget: tau3/task:t1 1/1 in use by alice (j_remote); killed"
    );
    expect(killed).toEqual(["a budget_lost"]);
  });

  it("stops admitting after abort and reports cancelled", async () => {
    const fake = newFake();
    const controller = new AbortController();
    const queue = [entry("a"), entry("b")];
    const running = processQueue(
      queue,
      options(fake, {
        suite_concurrency: 1,
        signal: controller.signal,
        kill_grace_ms: 5,
      })
    );
    await settled(() => expect(fake.running).toEqual(["a"]));
    controller.abort();
    const results = await running;
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBe("cancelled");
    expect(fake.order).toEqual(["a"]);
  });

  it("fails a queue entry that can never fit", async () => {
    const fake = newFake();
    await expect(
      processQueue(
        [entry("a", { concurrency_use: 4 })],
        options(fake, { suite_concurrency: 2 })
      )
    ).rejects.toThrow("can never run");
  });

  it("derives caps and timeouts", async () => {
    expect(dockerJobCap("arm64", {}, 12)).toBe(2);
    expect(dockerJobCap("x64", {}, 16)).toBe(4);
    // Clamped to the host's CPUs, never below one.
    expect(dockerJobCap("x64", {}, 2)).toBe(2);
    expect(dockerJobCap("x64", {}, 0)).toBe(1);
    // A positive integer override wins; anything else is ignored.
    expect(dockerJobCap("x64", { SUITE_DOCKER_COUNT: "6" }, 2)).toBe(6);
    expect(dockerJobCap("x64", { SUITE_DOCKER_COUNT: "2.5" }, 16)).toBe(4);
  });
});

describe("failures in the finish hook", () => {
  it("mark the job failed, are reported, and reach the results", async () => {
    const fake = newFake();
    const lines: string[] = [];
    const running = processQueue(
      [entry("a")],
      options(fake, {
        suite_concurrency: 4,
        report: (line) => lines.push(line),
        on_finished: async () => {
          throw new Error("ingest: bad usage.json");
        },
      })
    );
    await settled(() => expect(fake.running).toEqual(["a"]));
    fake.resolve.get("a")!();
    const results = await running;
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("ingest: bad usage.json");
    expect(
      lines.some((l) => l.includes("failed (ingest: bad usage.json)"))
    ).toBe(true);
    // The start line is followed by the exact command, as run.
    expect(lines.some((l) => l === "[a] $ true")).toBe(true);
  });
});
