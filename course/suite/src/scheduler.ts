import { createWriteStream } from "node:fs";
import { arch, availableParallelism } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { jobTimeoutMs } from "./budget.ts";
import type { SuiteRun } from "./expand.ts";
import type { HarborCommand } from "./harbor.ts";

/** A launched command the scheduler can observe and stop. */
export type Launched = {
  done: Promise<{ exit_code: number | null }>;
  signal: (signal: "SIGTERM" | "SIGKILL") => void;
};

export type LaunchRequest = {
  /** A shell command line. */
  command: string;
  env: Record<string, string>;
  log_file: string;
  verbose: boolean;
  prefix: string;
  report: (line: string) => void;
};

/** How commands start; swapped for a fake in tests. */
export type Launcher = (request: LaunchRequest) => Launched;

/** A queue entry: the run plus the resolved command and how much of each
 *  concurrency budget it holds while running. */
export type QueueEntry = {
  job_id: string;
  run: SuiteRun;
  env: Record<string, string>;
  /** Concurrent trials this job runs (`--n-concurrent`); its weight against
   *  the suite, task, driver, and target budgets. */
  concurrency_use: number;
  /** Whether the job counts against the local docker cap. */
  uses_docker: boolean;
  command: HarborCommand;
};

export type SchedulerOptions = {
  suite_concurrency: number;
  /** Max concurrent harbor jobs on local docker (0 = unlimited). */
  docker_jobs: number;
  log_dir: string;
  verbose?: boolean;
  signal?: AbortSignal;
  launcher?: Launcher;
  /** Called with a line of progress. */
  report?: (line: string) => void;
  /** Runs after a job's process exits, before its budget is released. */
  on_finished?: (entry: QueueEntry, result: JobResult) => Promise<void>;
  on_started?: (entry: QueueEntry) => Promise<void>;
  /** Runs after a timed-out or cancelled job's process group is gone: the
   *  cleanup its own process never got to do (e.g. deleting the Daytona
   *  sandboxes it made). A failure is added to the job's error. */
  on_killed?: (
    entry: QueueEntry,
    reason: "timed_out" | "cancelled"
  ) => Promise<void>;
  /** Why no further job may start, once there is a reason (e.g. results can
   *  no longer be stored, so every later job would be lost the same way). */
  halted?: () => string | null;
  kill_grace_ms?: number;
};

export type JobResult = {
  job_id: string;
  exit_code: number | null;
  ok: boolean;
  /** `timed_out` or `cancelled`; null when the exit code says it all. */
  error: string | null;
  started_at: Date;
  finished_at: Date;
  log_file: string;
};

/** Max concurrent docker jobs on a native (x86) host. Each job's environments
 *  are multi-GB task images, so even a big box doesn't stack more than this
 *  (disk, not cores, is the real ceiling). */
const MAX_NATIVE_DOCKER_JOBS = 4;

/** Max concurrent docker jobs on an arm64 host, where the amd64 task images
 *  run under emulation. Each emulated environment start is slow, and too many
 *  at once miss harbor's environment start timeout. */
const MAX_EMULATED_DOCKER_JOBS = 2;

/** Max harbor jobs running at once on the docker env, whatever each job's
 *  own trial concurrency; daytona has no local limit. SUITE_DOCKER_COUNT
 *  overrides when it is a positive integer. Otherwise the cap follows the
 *  architecture, clamped to the host's CPUs so a 2-vCPU runner doesn't start
 *  four heavy images at once. */
export function dockerJobCap(
  hostArch: string = arch(),
  env: NodeJS.ProcessEnv = process.env,
  hostCpus: number = availableParallelism()
): number {
  const raw = Number(env.SUITE_DOCKER_COUNT);
  if (Number.isInteger(raw) && raw > 0) return raw;
  const cap =
    hostArch === "arm64" ? MAX_EMULATED_DOCKER_JOBS : MAX_NATIVE_DOCKER_JOBS;
  return Math.max(1, Math.min(cap, hostCpus));
}

export const execaLauncher: Launcher = (request) => {
  // exec: the scheduler's SIGTERM reaches the command itself (harbor's
  // launcher), not a shell in front of it. Only here, where a shell runs the
  // command; the command as recorded and printed stays pasteable.
  const subprocess = execa(`exec ${request.command}`, {
    shell: true,
    env: request.env,
    extendEnv: true,
    detached: process.platform !== "win32",
    all: true,
    reject: false,
  });
  subprocess.all.pipe(createWriteStream(request.log_file));
  if (request.verbose) {
    subprocess.all.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.length > 0) console.log(`${request.prefix} ${line}`);
      }
    });
  }
  return {
    done: subprocess.then((result) => ({ exit_code: result.exitCode ?? null })),
    signal: (signal) => {
      if (subprocess.pid === undefined) return;
      try {
        // SIGTERM goes to the command alone (it execs harbor), so harbor gets
        // exactly one and runs its own teardown; SIGKILL, after the grace
        // period, takes the whole group harbor started.
        process.kill(
          signal === "SIGKILL" && process.platform !== "win32"
            ? -subprocess.pid
            : subprocess.pid,
          signal
        );
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ESRCH")
          return;
        // From a timer or an abort listener, a throw would crash the suite.
        request.report(
          `${request.prefix} could not send ${signal}: ${String(err)}`
        );
      }
    },
  };
};

type Budgets = Map<string, number>;

/** Drain the queue with skip-ahead admission: run the first pending job that
 *  fits the free suite concurrency, its task, driver, and target budgets, and
 *  the docker cap. */
export async function processQueue(
  queue: readonly QueueEntry[],
  options: SchedulerOptions
): Promise<JobResult[]> {
  const launcher = options.launcher ?? execaLauncher;
  const report = options.report ?? ((line) => console.log(line));
  const pending = [...queue];
  const running = new Set<Promise<void>>();
  const results: JobResult[] = [];
  const cancelled = () => options.signal?.aborted ?? false;
  const halted = () => options.halted?.() ?? null;

  let free = options.suite_concurrency;
  let docker_free = options.docker_jobs;
  const budget_free: Budgets = new Map();
  // Every cap a job counts against, merged from wherever it was declared:
  // the task in the suite file, the target in targets.json. The suite's own
  // concurrency is `free` above.
  const budgets = (entry: QueueEntry): Array<[string, number]> => {
    const { run } = entry;
    return [
      [`task:${run.task_name}`, run.task.concurrency ?? Infinity],
      [`target:${run.target_name}`, run.target.concurrency ?? Infinity],
    ];
  };
  const fits = (entry: QueueEntry): boolean => {
    if (entry.concurrency_use > free) return false;
    if (entry.uses_docker && options.docker_jobs > 0 && docker_free < 1)
      return false;
    return budgets(entry).every(
      ([key, cap]) => entry.concurrency_use <= (budget_free.get(key) ?? cap)
    );
  };
  const acquire = (entry: QueueEntry) => {
    free -= entry.concurrency_use;
    if (entry.uses_docker) docker_free -= 1;
    for (const [key, cap] of budgets(entry)) {
      budget_free.set(
        key,
        (budget_free.get(key) ?? cap) - entry.concurrency_use
      );
    }
  };
  const release = (entry: QueueEntry) => {
    free += entry.concurrency_use;
    if (entry.uses_docker) docker_free += 1;
    for (const [key] of budgets(entry)) {
      budget_free.set(key, budget_free.get(key)! + entry.concurrency_use);
    }
  };

  const stops = new Set<() => void>();
  const stop_all = () => {
    for (const stop of stops) stop();
  };
  process.once("exit", stop_all);

  const run_one = async (entry: QueueEntry): Promise<void> => {
    const prefix = `[${entry.job_id}]`;
    const log_file = path.join(options.log_dir, `${entry.job_id}.log`);
    const started_at = new Date();
    let error: string | null = null;
    let exit_code: number | null = null;
    try {
      await options.on_started?.(entry);
      report(
        `${prefix} start ${entry.run.task_name} × ${entry.run.driver_name} × ${entry.run.target_name}`
      );
      // The exact command, as run; secrets appear only as $NAME references.
      report(`${prefix} $ ${entry.command.shell}`);
      const launched = launcher({
        command: entry.command.shell,
        env: entry.env,
        log_file,
        verbose: options.verbose ?? false,
        prefix,
        report,
      });
      const kill = () => launched.signal("SIGKILL");
      stops.add(kill);
      let timed_out = false;
      let was_cancelled = false;
      let terminating: Promise<void> | undefined;
      const terminate = () => {
        if (terminating) return;
        clearTimeout(timer);
        launched.signal("SIGTERM");
        terminating = new Promise((resolve) =>
          setTimeout(() => {
            kill();
            resolve();
          }, options.kill_grace_ms ?? 10_000)
        );
      };
      const cancel = () => {
        if (terminating) return;
        was_cancelled = true;
        terminate();
      };
      const timeout_ms = jobTimeoutMs(entry.run, entry.concurrency_use);
      const timer =
        timeout_ms > 0
          ? setTimeout(() => {
              timed_out = true;
              terminate();
            }, timeout_ms)
          : undefined;
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const outcome = await launched.done;
        exit_code = outcome.exit_code;
        // The command can exit before children that closed their output
        // pipes; hold the job (and its budget) until the group is killed.
        await terminating;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        stops.delete(kill);
      }
      if (timed_out) {
        const waves = Math.max(
          1,
          Math.ceil(entry.run.count / Math.max(1, entry.concurrency_use))
        );
        error =
          `timed out after ${Math.round(timeout_ms / 60_000)}m ` +
          `(${entry.run.count} attempts / ${entry.concurrency_use} concurrent → ${waves} wave(s)); killed`;
        exit_code = null;
      } else if (was_cancelled) {
        error = "cancelled";
        exit_code = null;
      }
      if (timed_out || was_cancelled) {
        report(`${prefix} ${error}`);
        try {
          await options.on_killed?.(
            entry,
            timed_out ? "timed_out" : "cancelled"
          );
        } catch (err) {
          error += `; ${timed_out ? "timeout" : "cancellation"} cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
          report(`${prefix} ${error}`);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const result: JobResult = {
      job_id: entry.job_id,
      exit_code,
      ok: exit_code === 0 && error === null,
      error,
      started_at,
      finished_at: new Date(),
      log_file,
    };
    try {
      await options.on_finished?.(entry, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.error = result.error ? `${result.error}; ${message}` : message;
      result.ok = false;
    }
    const secs = (
      (result.finished_at.getTime() - started_at.getTime()) /
      1000
    ).toFixed(0);
    report(
      `${prefix} ${result.ok ? "done" : `failed (${result.error ?? `exit ${exit_code}`})`} in ${secs}s`
    );
    results.push(result);
  };

  try {
    while (pending.length > 0 || running.size > 0) {
      let admitted = false;
      if (!cancelled() && halted() === null) {
        for (let i = 0; i < pending.length; i++) {
          const entry = pending[i]!;
          if (!fits(entry)) continue;
          pending.splice(i, 1);
          i--;
          acquire(entry);
          const promise: Promise<void> = run_one(entry).finally(() => {
            release(entry);
            running.delete(promise);
          });
          running.add(promise);
          admitted = true;
        }
      }
      if (running.size === 0) {
        if (cancelled()) {
          report(`stopped: ${pending.length} job(s) not run`);
          break;
        }
        const reason = halted();
        if (reason !== null) {
          report(
            `stopping the suite: ${reason}; ${pending.length} job(s) not run`
          );
          break;
        }
        if (pending.length > 0 && !admitted) {
          const stuck = pending[0]!;
          throw new Error(
            `${stuck.job_id} can never run: concurrency ${stuck.concurrency_use} exceeds the suite concurrency or a task/target budget`
          );
        }
      }
      if (running.size > 0) await Promise.race(running);
    }
  } finally {
    process.removeListener("exit", stop_all);
  }
  return results;
}
