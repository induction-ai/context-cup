import path from "node:path";
import type { RunSpec, SuiteRun } from "../src/expand.ts";
import { zSuiteFile, type SuiteFile } from "../src/keys.ts";
import type { CupPackage } from "../src/packages.ts";
import { zTargetsFile, type TargetsFile } from "../src/targets.ts";

export const FIXTURES = path.join(import.meta.dirname, "fixtures");
export const FIXTURE_JOBS_DIR = path.join(FIXTURES, "job");

export function sampleSuite(overrides: Partial<SuiteFile> = {}): SuiteFile {
  return zSuiteFile.parse({
    tasks: {
      banking_001: { runner: "tau3", tau3: { customer: "banking_001" } },
      sales_accounting: { runner: "toolathlon", concurrency: 1 },
      hidden: {
        runner: "tau3",
        tau3: { customer: "banking_002" },
        explicit_only: true,
      },
    },
    ...overrides,
  });
}

export function sampleTargets(): TargetsFile {
  return zTargetsFile.parse({
    "gpt-5.5@medium": {
      provider: "openai",
      model: "gpt-5.5",
      reasoning_effort: "medium",
    },
    "claude-sonnet-4-6": { provider: "anthropic", model: "claude-sonnet-4-6" },
    "gemini-3.1-pro-preview": {
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
    },
  });
}

export function sampleSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    driver_name: "base_passthrough",
    target_name: "gpt-5.5@medium",
    target: sampleTargets()["gpt-5.5@medium"]!,
    count: 2,
    ...overrides,
  };
}

export function sampleRun(overrides: Partial<SuiteRun> = {}): SuiteRun {
  const file = sampleSuite();
  return {
    ...sampleSpec(),
    task_name: "banking_001",
    task: file.tasks.banking_001!,
    runner: "tau3",
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
      providers: ["openai", "anthropic"],
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
      providers: ["openai"],
      config: { max_bytes: 100000 },
      description: "Clips oversized tool results.",
    },
    {
      name: "@context-cup-drivers/base_codex",
      dir: "/ws/drivers/base_codex",
      kind: "agent",
      harbor_agent: "context_cup_runner.codex:CodexAgent",
      providers: ["openai"],
      description: "Codex CLI as a whole agent.",
    },
  ];
  return new Map(pkgs.map((p) => [p.name, p]));
}
