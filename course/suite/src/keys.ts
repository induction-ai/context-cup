import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDERS, type Provider } from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import z from "zod";
import { tau3TaskGlob, toolathlonTaskDir } from "./tasks.ts";

export { PROVIDERS, type Provider };

const zTaskCommon = {
  concurrency: z.number().int().positive().optional(),
  explicit_only: z.boolean().optional(),
  timeout_minutes: z.number().positive().optional(),
};

// Strict throughout: a misspelt key (`timeout_minute`) is an error, not a
// silently ignored setting.
const zTask = z.discriminatedUnion("runner", [
  z.strictObject({
    runner: z.literal("tau3"),
    tau3: z.strictObject({ customer: z.string().min(1) }),
    ...zTaskCommon,
  }),
  z.strictObject({
    runner: z.literal("toolathlon"),
    /** `task` defaults to the suite-file key. */
    toolathlon: z
      .strictObject({ task: z.string().min(1).optional() })
      .default({}),
    ...zTaskCommon,
  }),
]);
export type SuiteTask = z.infer<typeof zTask>;
export type RunnerName = SuiteTask["runner"];

/** A suite file is the tasks and how hard to run them. The driver and the
 *  target are chosen at launch (`bin/suite --driver … --target …`). */
export const zSuiteFile = z
  .object({
    /** Max concurrent trials across the whole suite. */
    concurrency: z.number().int().positive().default(8),
    /** Trials per task when `--count` isn't given (default 1). */
    count: z.number().int().positive().optional(),
    /** Per-trial budget for the agent; harbor's timeout multiplier derives
     *  from it. Unset, harbor keeps each task's own timeout. */
    timeout_minutes: z.number().positive().optional(),
    tasks: z.record(z.string(), zTask),
  })
  // Drivers and targets are launch choices, never part of a suite file.
  .strict();
export type SuiteFile = z.infer<typeof zSuiteFile>;

export const SUITES_DIR = path.join(REPO_ROOT, "suites");
export function listSuiteKeys(): string[] {
  if (!existsSync(SUITES_DIR)) return [];
  return readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Resolve a suite key (`smoke_tau`) or a path to a suite file. */
export function suiteFilePath(key: string): string {
  if (key.endsWith(".json") && existsSync(key)) return path.resolve(key);
  const file = path.join(SUITES_DIR, `${key}.json`);
  if (existsSync(file)) return file;
  throw new Error(
    `Unknown suite key "${key}". Available: ${listSuiteKeys().join(", ")}`
  );
}

/** Parse and validate a suite file: every task must resolve to a harbor task. */
export function parseSuiteFile(raw: unknown): SuiteFile {
  const file = zSuiteFile.parse(raw);
  for (const [name, task] of Object.entries(file.tasks)) {
    if (task.runner === "tau3") tau3TaskGlob(task.tau3.customer);
    else toolathlonTaskDir(task.toolathlon.task ?? name);
  }
  return file;
}

export function loadSuiteFile(key: string): { path: string; file: SuiteFile } {
  const file = suiteFilePath(key);
  return {
    path: file,
    file: parseSuiteFile(JSON.parse(readFileSync(file, "utf8"))),
  };
}
