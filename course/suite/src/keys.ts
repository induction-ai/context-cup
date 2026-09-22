import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PROVIDERS,
  zProvider,
  type Provider,
} from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import z from "zod";
import { findDriver } from "./packages.ts";
import { tau3TaskGlob, toolathlonTaskDir } from "./tasks.ts";

export { PROVIDERS, type Provider };

const zTarget = z.object({
  provider: zProvider,
  model: z.string().min(1),
  reasoning_effort: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  explicit_only: z.boolean().optional(),
});
export type SuiteTarget = z.infer<typeof zTarget>;

const zDriver = z.object({
  /** Trials per (task, driver, target); harbor `--n-attempts`. */
  count: z.number().int().positive().default(1),
  explicit_only: z.boolean().optional(),
});
export type SuiteDriver = z.infer<typeof zDriver>;

const zTaskCommon = {
  concurrency: z.number().int().positive().optional(),
  explicit_only: z.boolean().optional(),
  timeout_minutes: z.number().positive().optional(),
};

const zTask = z.discriminatedUnion("runner", [
  z.object({
    runner: z.literal("tau3"),
    tau3: z.object({ customer: z.string().min(1) }),
    ...zTaskCommon,
  }),
  z.object({
    runner: z.literal("toolathlon"),
    /** `task` defaults to the suite-file key. */
    toolathlon: z.object({ task: z.string().min(1).optional() }).default({}),
    ...zTaskCommon,
  }),
]);
export type SuiteTask = z.infer<typeof zTask>;
export type RunnerName = SuiteTask["runner"];

export const zSuiteFile = z.object({
  suite_name: z.string().min(1),
  /** Max concurrent trials across the whole suite. */
  concurrency: z.number().int().positive().default(8),
  /** Per-task budget for the agent; harbor's timeout multiplier derives from it. */
  timeout_minutes: z.number().positive().default(40),
  targets: z.record(z.string(), zTarget),
  drivers: z.record(z.string(), zDriver),
  tasks: z.record(z.string(), zTask),
});
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

/** Parse and validate a suite file: every driver must exist under drivers/
 *  and every task must resolve to a harbor task. */
export function parseSuiteFile(
  raw: unknown,
  options: { checkDrivers?: boolean } = {}
): SuiteFile {
  const file = zSuiteFile.parse(raw);
  for (const [name, task] of Object.entries(file.tasks)) {
    if (task.runner === "tau3") tau3TaskGlob(task.tau3.customer);
    else toolathlonTaskDir(task.toolathlon.task ?? name);
  }
  if (options.checkDrivers ?? true) {
    for (const name of Object.keys(file.drivers)) findDriver(name);
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
