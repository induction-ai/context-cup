import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  describeTarget,
  loadTargets,
  lookupTarget,
  parseTargetsFile,
  targetsForProviders,
  zTargetsFile,
} from "../src/targets.ts";
import { sampleTargets } from "./helpers.ts";

describe("targets.json", () => {
  it("parses named targets", async () => {
    const targets = parseTargetsFile({
      "gpt-5.5@medium": {
        provider: "openai",
        model: "gpt-5.5",
        reasoning_effort: "medium",
      },
      "claude-sonnet-4-6": {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });
    expect(Object.keys(targets)).toEqual([
      "gpt-5.5@medium",
      "claude-sonnet-4-6",
    ]);
    expect(describeTarget(targets["gpt-5.5@medium"]!)).toBe(
      "openai/gpt-5.5@medium"
    );
    expect(describeTarget(targets["claude-sonnet-4-6"]!)).toBe(
      "anthropic/claude-sonnet-4-6"
    );
  });

  it("rejects an unknown provider and an empty file", async () => {
    expect(() =>
      parseTargetsFile({ x: { provider: "fireworks", model: "m" } })
    ).toThrow();
    expect(() => parseTargetsFile({})).toThrow("names no targets");
  });

  it("looks a name up or lists the names", async () => {
    const targets = sampleTargets();
    expect(lookupTarget("claude-sonnet-4-6", targets).provider).toBe(
      "anthropic"
    );
    expect(() => lookupTarget("nope", targets)).toThrow(
      /Unknown target "nope".*gpt-5\.5@medium, claude-sonnet-4-6, gemini-3\.1-pro-preview/
    );
  });

  it("filters targets to the providers a driver supports", async () => {
    const names = (providers: Parameters<typeof targetsForProviders>[1]) =>
      targetsForProviders(sampleTargets(), providers).map(([n]) => n);
    expect(names(["openai"])).toEqual(["gpt-5.5@medium"]);
    expect(names(["anthropic", "gemini"])).toEqual([
      "claude-sonnet-4-6",
      "gemini-3.1-pro-preview",
    ]);
    expect(names([])).toEqual([]);
  });

  it("the checked-in targets.json loads and names an openai target", async () => {
    const targets = loadTargets();
    expect(Object.values(targets).some((t) => t.provider === "openai")).toBe(
      true
    );
  });
});

describe("target concurrency", () => {
  it("parses an optional per-target cap", async () => {
    const parsed = zTargetsFile.parse({
      slow: { provider: "openai", model: "m", concurrency: 4 },
      fast: { provider: "openai", model: "m" },
    });
    expect(parsed.slow!.concurrency).toBe(4);
    expect(parsed.fast!.concurrency).toBeUndefined();
    expect(() =>
      zTargetsFile.parse({
        bad: { provider: "openai", model: "m", concurrency: 0 },
      })
    ).toThrow();
  });

  it("is merged into a job's concurrency with the suite's and the task's", async () => {
    const { jobConcurrency } = await import("../src/cli.ts");
    const { sampleRun } = await import("./helpers.ts");
    const run = sampleRun({
      count: 10,
      target: { provider: "openai", model: "m", concurrency: 4 },
    });
    expect(jobConcurrency(run, 8)).toBe(4);
    expect(
      jobConcurrency({ ...run, target: { provider: "openai", model: "m" } }, 8)
    ).toBe(8);
  });
});
