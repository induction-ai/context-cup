import { createWriteStream } from "node:fs";
import { arch, availableParallelism } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { jobTimeoutMs } from "./budget.ts";
import type { SuiteRun } from "./expand.ts";
import type { HarborCommand } from "./harbor.ts";
import type {
  AcquireResult,
  BlockedBudget,
  BudgetClaim,
  SharedBudgets,
} from "./shared_budgets.ts";

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
  /** The task and target budgets, shared with every other bin/suite on any
   *  machine. */
  budgets: SharedBudgets;
  /** How long to wait before re-checking a budget another machine holds.
   *  Default: DEFAULT_POLL_MS. */
  poll_ms?: number;
  log_dir: string;
  verbose?: boolean;
  signal?: AbortSignal;
  launcher?: Launcher;
  /** Called with a line of progress. */
  report?: (line: string) => void;
  /** Runs after a job's process exits, before its budget is released. */
  on_finished?: (entry: QueueEntry, result: JobResult) => Promise<void>;
  on_started?: (entry: QueueEntry) => Promise<void>;
  /** Runs after a stopped job's process group is gone (it timed out, the
   *  suite was cancelled, or another machine took its budget while this one
   *  could not re-assert it): the cleanup its own process never got to do
   *  (e.g. deleting the Daytona sandboxes it made). A failure is added to the
   *  job's error. */
  on_killed?: (entry: QueueEntry, reason: KillReason) => Promise<void>;
  /** Why no further job may start, once there is a reason (e.g. results can
   *  no longer be stored, so every later job would be lost the same way). */
  halted?: () => string | null;
  kill_grace_ms?: number;
};

export type KillReason = "timed_out" | "cancelled" | "budget_lost";

const KILL_LABEL: Record<KillReason, string> = {
  timed_out: "timeout",
  cancelled: "cancellation",
  budget_lost: "budget loss",
};

export type JobResult = {
  job_id: string;
  exit_code: number | null;
  ok: boolean;
  /** Why the job was stopped or could not run; null when the exit code says
   *  it all. */
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

/** Jobs run for minutes, so a minute of idle per hand-off between machines
 *  costs little and keeps the database quiet. */
export const DEFAULT_POLL_MS = 60_000;

/** Resolves after ms, as soon as the signal aborts, or when cancelled. */
function sleep(
  ms: number,
  signal?: AbortSignal
): { done: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const done = new Promise<void>((resolve) => {
    cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(cancel, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  return { done, cancel };
}

function describeBlocked(blocked: BlockedBudget[]): string {
  return blocked
    .map(
      (budget) =>
        `${budget.key} ${budget.in_use}/${budget.capacity} in use by ` +
        budget.holds.map((hold) => `${hold.holder} (${hold.job_id})`).join(", ")
    )
    .join("; ");
}

/** The budgets a job draws from on every machine, merged from wherever each
 *  cap was declared: the task in the suite file, the target in targets.json.
 *  A task's key carries its runner, so the smoke, local, and full suites of
 *  one benchmark share it (the same task acts on the same accounts whichever
 *  file lists it); a target's cap is one provider's rate limit, shared by
 *  everything. A cap left off is unlimited for this run, but the hold still
 *  counts against a run that sets one. */
export function budgetClaims(entry: QueueEntry): BudgetClaim[] {
  const { run } = entry;
  const weight = entry.concurrency_use;
  return [
    {
      key: `${run.runner}/task:${run.task_name}`,
      capacity: run.task.concurrency ?? Infinity,
      weight,
    },
    {
      key: `target:${run.target_name}`,
      capacity: run.target.concurrency ?? Infinity,
      weight,
    },
  ];
}

/** Drain the queue with skip-ahead admission: run the first pending job that
 *  fits the free suite concurrency and the docker cap, and whose task and
 *  target budgets have room across every machine. A job blocked only by
 *  another machine's holds waits and is re-checked every poll_ms. */
export async function processQueue(
  queue: readonly QueueEntry[],
  options: SchedulerOptions
): Promise<JobResult[]> {
  const launcher = options.launcher ?? execaLauncher;
  const report = options.report ?? ((line) => console.log(line));
  const poll_ms = options.poll_ms ?? DEFAULT_POLL_MS;
  const pending = [...queue];
  const running = new Set<Promise<void>>();
  const results: JobResult[] = [];
  const cancelled = () => options.signal?.aborted ?? false;
  const halted = () => options.halted?.() ?? null;

  let free = options.suite_concurrency;
  let docker_free = options.docker_jobs;
  /** Whether this process has room for the job; the shared budgets are then
   *  asked. */
  const fits = (entry: QueueEntry): boolean => {
    if (entry.concurrency_use > free) return false;
    if (entry.uses_docker && options.docker_jobs > 0 && docker_free < 1)
      return false;
    return true;
  };
  const acquire = (entry: QueueEntry) => {
    free -= entry.concurrency_use;
    if (entry.uses_docker) docker_free -= 1;
  };
  const release = async (entry: QueueEntry) => {
    free += entry.concurrency_use;
    if (entry.uses_docker) docker_free += 1;
    try {
      await options.budgets.release(entry.job_id);
    } catch (err) {
      // The hold expires on its own once this process stops asserting it.
      report(
        `[${entry.job_id}] could not release shared budgets: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  /** Jobs told to stop because another machine took their budget while this
   *  one could not re-assert it, by job id. */
  const budget_losers = new Map<string, (reason: string) => void>();
  options.budgets.on_lost = ({ job_id, blocked }) => {
    budget_losers.get(job_id)?.(
      `lost shared budget: ${describeBlocked(blocked)}`
    );
  };
  /** Jobs waiting on another machine's holds, so each is logged once. */
  const waiting = new Set<string>();

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
    let budget_lost: string | null = null;
    /** Stops the running job; set once it has started. */
    let stop_for_lost_budget: (() => void) | null = null;
    budget_losers.set(entry.job_id, (reason) => {
      if (budget_lost !== null) return;
      budget_lost = reason;
      stop_for_lost_budget?.();
    });
    try {
      await options.on_started?.(entry);
      if (budget_lost !== null) {
        throw new Error(`${budget_lost}; not started`);
      }
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
      stop_for_lost_budget = terminate;
      if (budget_lost !== null) terminate();
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
      let reason: KillReason | null = null;
      if (timed_out) {
        const waves = Math.max(
          1,
          Math.ceil(entry.run.count / Math.max(1, entry.concurrency_use))
        );
        error =
          `timed out after ${Math.round(timeout_ms / 60_000)}m ` +
          `(${entry.run.count} attempts / ${entry.concurrency_use} concurrent → ${waves} wave(s)); killed`;
        reason = "timed_out";
      } else if (was_cancelled) {
        error = "cancelled";
        reason = "cancelled";
      } else if (budget_lost !== null) {
        error = `${budget_lost}; killed`;
        reason = "budget_lost";
      }
      if (reason !== null) {
        exit_code = null;
        report(`${prefix} ${error}`);
        try {
          await options.on_killed?.(entry, reason);
        } catch (err) {
          error += `; ${KILL_LABEL[reason]} cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
          report(`${prefix} ${error}`);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      budget_losers.delete(entry.job_id);
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
      /** Whether some pending job is held back by another machine, or by a
       *  database that could not be reached; either clears without this
       *  process finishing a job, so the loop polls instead of only
       *  waiting. */
      let blocked_elsewhere = false;
      for (let i = 0; i < pending.length; i++) {
        if (cancelled() || halted() !== null) break;
        const entry = pending[i]!;
        if (!fits(entry)) continue;
        let result: AcquireResult;
        try {
          result = await options.budgets.acquire(
            entry.job_id,
            budgetClaims(entry)
          );
        } catch (err) {
          // Running jobs keep going; admission is tried again next poll.
          report(
            `shared budgets unreachable, retrying in ${poll_ms / 1000}s: ${err instanceof Error ? err.message : String(err)}`
          );
          blocked_elsewhere = true;
          break;
        }
        if (!result.admitted) {
          const by_this_process = result.blocked.every((budget) =>
            budget.holds.every(
              (hold) => hold.invocation_id === options.budgets.invocation_id
            )
          );
          // A budget this process fills frees up when one of its own jobs
          // finishes, which already wakes the loop.
          if (by_this_process) continue;
          blocked_elsewhere = true;
          if (!waiting.has(entry.job_id)) {
            waiting.add(entry.job_id);
            report(
              `[${entry.job_id}] waiting: ${describeBlocked(result.blocked)}`
            );
          }
          continue;
        }
        if (waiting.delete(entry.job_id)) {
          report(`[${entry.job_id}] budget free, starting`);
        }
        pending.splice(i, 1);
        i--;
        acquire(entry);
        const promise: Promise<void> = run_one(entry).finally(async () => {
          await release(entry);
          running.delete(promise);
        });
        running.add(promise);
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
        if (pending.length > 0 && !blocked_elsewhere) {
          const stuck = pending[0]!;
          throw new Error(
            `${stuck.job_id} can never run: concurrency ${stuck.concurrency_use} exceeds the suite concurrency or a task/target budget`
          );
        }
      }
      if (blocked_elsewhere) {
        const poll = sleep(poll_ms, options.signal);
        await Promise.race([...running, poll.done]);
        poll.cancel();
      } else if (running.size > 0) {
        await Promise.race(running);
      }
    }
  } finally {
    process.removeListener("exit", stop_all);
  }
  return results;
}
