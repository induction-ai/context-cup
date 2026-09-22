import path from "node:path";
import type { SuiteRun } from "../src/expand.ts";
import { zSuiteFile, type SuiteFile } from "../src/keys.ts";
import type { CupPackage } from "../src/packages.ts";

export const FIXTURES = path.join(import.meta.dirname, "fixtures");
export const FIXTURE_JOBS_DIR = path.join(FIXTURES, "job");

export function sampleSuite(overrides: Partial<SuiteFile> = {}): SuiteFile {
  return zSuiteFile.parse({
    suite_name: "sample",
    targets: {
      "gpt-5.5@medium": {
        provider: "openai",
        model: "gpt-5.5",
        reasoning_effort: "medium",
      },
      "claude-sonnet-4-6": {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        explicit_only: true,
      },
    },
    drivers: {
      base_passthrough: { count: 2 },
      base_truncate: { explicit_only: true },
    },
    tasks: {
      banking_001: { runner: "tau3", tau3: { customer: "banking_001" } },
      sales_accounting: { runner: "toolathlon", concurrency: 1 },
    },
    ...overrides,
  });
}

export function sampleRun(overrides: Partial<SuiteRun> = {}): SuiteRun {
  const file = sampleSuite();
  return {
    task_name: "banking_001",
    task: file.tasks.banking_001!,
    runner: "tau3",
    driver_name: "base_passthrough",
    driver: file.drivers.base_passthrough!,
    target_name: "gpt-5.5@medium",
    target: file.targets["gpt-5.5@medium"]!,
    count: 2,
    timeout_minutes: 40,
    ...overrides,
  };
}

/** An in-memory workspace: engine-python <- base_passthrough / base_truncate. */
export function samplePackages(): Map<string, CupPackage> {
  const pkgs: CupPackage[] = [
    {
      name: "@context-cup/engine-python",
      dir: "/ws/engines/python",
      kind: "engine",
    },
    {
      name: "@context-cup-drivers/base_passthrough",
      dir: "/ws/drivers/base_passthrough",
      kind: "driver",
      extends: "@context-cup/engine-python",
    },
    {
      name: "@context-cup-drivers/base_truncate",
      dir: "/ws/drivers/base_truncate",
      kind: "driver",
      extends: "@context-cup/engine-python",
      config: { max_bytes: 100000 },
    },
  ];
  return new Map(pkgs.map((p) => [p.name, p]));
}
