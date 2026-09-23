import type { RunnerName, SuiteFile, SuiteTask } from "./keys.ts";
import type { Target } from "./targets.ts";

/** What a run drives: the one driver and one target chosen at launch. */
export type RunSpec = {
  driver_name: string;
  target_name: string;
  target: Target;
  /** Trials per task (harbor `--n-attempts`). */
  count: number;
};

/** One task of the suite: a harbor job to run. */
export type SuiteRun = RunSpec & {
  task_name: string;
  task: SuiteTask;
  runner: RunnerName;
  /** Minutes the agent gets per trial. */
  timeout_minutes: number;
};

/** Task filter from the command line. Naming tasks selects only those and
 *  lifts their `explicit_only`. */
export type Selection = { task?: string[] };

function chosenTasks(
  file: SuiteFile,
  selection: Selection
): Array<[string, SuiteTask]> {
  const names = selection.task;
  if (names && names.length > 0) {
    return names.map((name) => {
      const task = file.tasks[name];
      if (!task) {
        throw new Error(
          `Unknown task "${name}". Available: ${Object.keys(file.tasks).join(", ")}`
        );
      }
      return [name, task];
    });
  }
  return Object.entries(file.tasks).filter(([, t]) => !t.explicit_only);
}

/** One run per task, minus explicit-only tasks not named on the command
 *  line. See {@link interleave} for queue order. */
export function expandSuite(
  file: SuiteFile,
  spec: RunSpec,
  selection: Selection = {}
): SuiteRun[] {
  return chosenTasks(file, selection).map(([task_name, task]) => ({
    ...spec,
    task_name,
    task,
    runner: task.runner,
    timeout_minutes: task.timeout_minutes ?? file.timeout_minutes,
  }));
}

/** Reorder so consecutive entries are different tasks, drawing at random
 *  within a task. With one run per task this is a shuffle across tasks. */
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
