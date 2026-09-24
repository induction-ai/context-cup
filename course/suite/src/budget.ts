/** How long a job may run, and how long its Daytona sandboxes outlive it. */
import type { SuiteRun } from "./expand.ts";

/** Setup, verification, and collection around the agent's own budget. */
const JOB_OVERHEAD_MIN = 30;

/** Minutes past a job's budget before Daytona stops (and so deletes) a
 *  sandbox the job left behind. */
const AUTO_STOP_MARGIN_MIN = 10;

/** Sandbox auto-stop for a job with no budget to derive one from: long enough
 *  not to interrupt it, short enough that an abandoned sandbox stops holding
 *  quota the same day. */
const UNCAPPED_AUTO_STOP_MIN = 120;

/** A trial's budget when the suite sets no `timeout_minutes`.
 *  SUITE_COMMAND_TIMEOUT_MIN overrides; zero or less means no deadline. */
export function fallbackBudgetMinutes(env = process.env): number {
  const raw = env.SUITE_COMMAND_TIMEOUT_MIN;
  if (raw === undefined || raw.trim() === "") return 150;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 150;
}

/** One wave of a job's trials: the agent's budget plus overhead, or the
 *  fallback when the suite leaves the agent timeout to harbor. */
export function waveBudgetMinutes(run: SuiteRun, env = process.env): number {
  return run.timeout_minutes === null
    ? fallbackBudgetMinutes(env)
    : run.timeout_minutes + JOB_OVERHEAD_MIN;
}

/** Wall clock for one job: a wave's budget once per wave of sequential
 *  attempts. Zero means no deadline. */
export function jobTimeoutMs(
  run: SuiteRun,
  concurrency_use: number,
  env = process.env
): number {
  const per_wave = waveBudgetMinutes(run, env);
  if (per_wave <= 0) return 0;
  const waves = Math.max(
    1,
    Math.ceil(run.count / Math.max(1, concurrency_use))
  );
  return per_wave * waves * 60_000;
}

/** Idle minutes before Daytona stops a sandbox: its trial's whole budget
 *  must be able to finish first. */
export function sandboxAutoStopMinutes(
  run: SuiteRun,
  env = process.env
): number {
  const budget = waveBudgetMinutes(run, env);
  return budget > 0 ? budget + AUTO_STOP_MARGIN_MIN : UNCAPPED_AUTO_STOP_MIN;
}
