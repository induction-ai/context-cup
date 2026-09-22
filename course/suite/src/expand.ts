import type {
  Provider,
  RunnerName,
  SuiteDriver,
  SuiteFile,
  SuiteTarget,
  SuiteTask,
} from "./keys.ts";

/** The three axes of the suite matrix. */
export type Axis = "task" | "driver" | "target";

/** One cell of the matrix: a harbor job to run. */
export type SuiteRun = {
  task_name: string;
  task: SuiteTask;
  runner: RunnerName;
  driver_name: string;
  driver: SuiteDriver;
  target_name: string;
  target: SuiteTarget;
  /** Trials for this cell (harbor `--n-attempts`). */
  count: number;
  /** Minutes the agent gets per trial. */
  timeout_minutes: number;
};

/** CLI filters per axis. Naming an axis on the command line selects only
 *  those entries and lifts their `explicit_only`. */
export type Selection = Partial<Record<Axis, string[]>>;

function chosen<T extends { explicit_only?: boolean }>(
  entries: Record<string, T>,
  axis: Axis,
  selection: Selection
): Array<[string, T]> {
  const names = selection[axis];
  if (names && names.length > 0) {
    return names.map((name) => {
      const entry = entries[name];
      if (!entry) {
        throw new Error(
          `Unknown ${axis} "${name}". Available: ${Object.keys(entries).join(", ")}`
        );
      }
      return [name, entry];
    });
  }
  return Object.entries(entries).filter(([, entry]) => !entry.explicit_only);
}

/** tasks × drivers × targets, minus explicit-only entries not named on the
 *  command line. Grouped by task; see {@link interleave} for queue order. */
export function expandSuite(
  file: SuiteFile,
  selection: Selection = {}
): SuiteRun[] {
  const tasks = chosen(file.tasks, "task", selection);
  const drivers = chosen(file.drivers, "driver", selection);
  const targets = chosen(file.targets, "target", selection);
  const runs: SuiteRun[] = [];
  for (const [task_name, task] of tasks) {
    for (const [driver_name, driver] of drivers) {
      for (const [target_name, target] of targets) {
        runs.push({
          task_name,
          task,
          runner: task.runner,
          driver_name,
          driver,
          target_name,
          target,
          count: driver.count,
          timeout_minutes: task.timeout_minutes ?? file.timeout_minutes,
        });
      }
    }
  }
  return runs;
}

export type SkippedRun = {
  driver_name: string;
  target_name: string;
  provider: Provider;
};

/** Drop cells whose driver does not support the target's provider.
 *  `providersOf` resolves a driver's supported providers (see
 *  `driverProviders` in packages.ts); unsupported cells come back in
 *  `skipped` so the caller can say so. */
export function dropUnsupported(
  runs: SuiteRun[],
  providersOf: (driver_name: string) => readonly Provider[]
): { runs: SuiteRun[]; skipped: SkippedRun[] } {
  const kept: SuiteRun[] = [];
  const skipped: SkippedRun[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (providersOf(run.driver_name).includes(run.target.provider)) {
      kept.push(run);
      continue;
    }
    const key = `${run.driver_name}|${run.target_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      skipped.push({
        driver_name: run.driver_name,
        target_name: run.target_name,
        provider: run.target.provider,
      });
    }
  }
  return { runs: kept, skipped };
}

/** Reorder so consecutive entries are different tasks and a task's
 *  driver/target cells come out in random order. The scheduler admits the
 *  first pending entries that fit, so expanded order would start one task
 *  against every driver and target at once. */
export function interleave(
  runs: readonly SuiteRun[],
  random: () => number = Math.random
): SuiteRun[] {
  const remaining = new Map<string, SuiteRun[]>();
  for (const run of runs) {
    const bucket = remaining.get(run.task_name);
    if (bucket) bucket.push(run);
    else remaining.set(run.task_name, [run]);
  }
  const out: SuiteRun[] = [];
  while (out.length < runs.length) {
    for (const bucket of remaining.values()) {
      if (bucket.length === 0) continue;
      const [drawn] = bucket.splice(Math.floor(random() * bucket.length), 1);
      out.push(drawn!);
    }
  }
  return out;
}
