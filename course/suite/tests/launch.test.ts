import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { driverChoices, resolveLaunch, type Asker } from "../src/launch.ts";
import { samplePackages, sampleTargets } from "./helpers.ts";

/** An asker that records what it was shown and answers by index. */
function scripted(answers: number[]): {
  ask: Asker;
  shown: Array<{ question: string; names: string[] }>;
} {
  const shown: Array<{ question: string; names: string[] }> = [];
  const ask: Asker = async (question, choices) => {
    shown.push({ question, names: choices.map((c) => c.name) });
    return answers.shift()!;
  };
  return { ask, shown };
}

const base = () => ({ targets: sampleTargets(), packages: samplePackages() });

describe("resolveLaunch", () => {
  it("accepts a driver and a target it supports without prompting", async () => {
    const launch = await resolveLaunch({
      ...base(),
      driver: "base_passthrough",
      target: "claude-sonnet-4-6",
      ask: null,
    });
    expect(launch).toEqual({
      driver_name: "base_passthrough",
      target_name: "claude-sonnet-4-6",
      target: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
  });

  it("rejects a driver that does not support the target's provider", async () => {
    await expect(
      resolveLaunch({
        ...base(),
        driver: "base_truncate",
        target: "claude-sonnet-4-6",
        ask: null,
      })
    ).rejects.toThrow(
      /base_truncate does not support provider anthropic.*supports openai.*gpt-5\.5@medium/
    );
  });

  it("rejects unknown drivers and targets with the lists", async () => {
    await expect(
      resolveLaunch({ ...base(), driver: "nope", target: "x", ask: null })
    ).rejects.toThrow(/Unknown driver "nope".*base_passthrough, base_truncate/);
    await expect(
      resolveLaunch({
        ...base(),
        driver: "base_passthrough",
        target: "nope",
        ask: null,
      })
    ).rejects.toThrow(/Unknown target "nope"/);
  });

  it("without a terminal, a missing flag fails with the choices", async () => {
    await expect(resolveLaunch({ ...base(), ask: null })).rejects.toThrow(
      /--driver is required.*base_passthrough, base_truncate/
    );
    await expect(
      resolveLaunch({ ...base(), driver: "base_truncate", ask: null })
    ).rejects.toThrow(
      /--target is required.*base_truncate can run: gpt-5\.5@medium/
    );
  });

  it("with a terminal, asks for the driver then a target the driver can run", async () => {
    const { ask, shown } = scripted([2, 0]);
    const launch = await resolveLaunch({ ...base(), ask });
    expect(shown).toEqual([
      {
        question: "Driver",
        names: ["base_codex", "base_passthrough", "base_truncate"],
      },
      { question: "Target model", names: ["gpt-5.5@medium"] },
    ]);
    expect(launch.driver_name).toBe("base_truncate");
    expect(launch.target_name).toBe("gpt-5.5@medium");
  });

  it("with the driver given, asks only for the target, filtered to its providers", async () => {
    const { ask, shown } = scripted([1]);
    const launch = await resolveLaunch({
      ...base(),
      driver: "base_passthrough",
      ask,
    });
    expect(shown).toEqual([
      {
        question: "Target model",
        names: ["gpt-5.5@medium", "claude-sonnet-4-6"],
      },
    ]);
    expect(launch.target_name).toBe("claude-sonnet-4-6");
  });

  it("fails when the driver supports no configured target", async () => {
    const targets = { only: { provider: "gemini" as const, model: "g" } };
    await expect(
      resolveLaunch({
        targets,
        packages: samplePackages(),
        driver: "base_truncate",
        ask: scripted([]).ask,
      })
    ).rejects.toThrow(
      /base_truncate supports openai.*no target for those providers/
    );
  });

  it("driver choices carry each package's description", async () => {
    expect(driverChoices(samplePackages())).toEqual([
      { name: "base_codex", detail: "Codex CLI as a whole agent." },
      { name: "base_passthrough", detail: "" },
      { name: "base_truncate", detail: "Clips oversized tool results." },
    ]);
  });
});

describe("run provenance", () => {
  it("links to the results site and records the GitHub run when present", async () => {
    const { githubRun, suiteUrl } = await import("../src/cli.ts");
    expect(suiteUrl("s_abc", {})).toBe("http://localhost:3300/suites/s_abc");
    expect(suiteUrl("s_abc", { SITE_URL: "https://cup.example/" })).toBe(
      "https://cup.example/suites/s_abc"
    );
    expect(githubRun({})).toEqual({
      githubRunId: null,
      githubRunAttempt: null,
      githubRepository: null,
    });
    expect(
      githubRun({
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_REPOSITORY: "example/context-cup",
      })
    ).toEqual({
      githubRunId: "123",
      githubRunAttempt: 2,
      githubRepository: "example/context-cup",
    });
  });
});
