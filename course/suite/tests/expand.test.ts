import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { expandSuite, interleave } from "../src/expand.ts";
import { sampleSpec, sampleSuite } from "./helpers.ts";

describe("expandSuite", () => {
  it("makes one run per task, carrying the launch spec", async () => {
    const runs = expandSuite(sampleSuite(), sampleSpec());
    expect(runs.map((r) => r.task_name)).toEqual([
      "banking_001",
      "sales_accounting",
    ]);
    expect(runs[0]).toMatchObject({
      driver_name: "base_passthrough",
      target_name: "gpt-5.5@medium",
      target: { provider: "openai", model: "gpt-5.5" },
      count: 2,
      runner: "tau3",
      timeout_minutes: null,
    });
  });

  it("takes the largest timeout set at any level, or none", async () => {
    const file = sampleSuite();
    const withTimeouts = {
      ...file,
      timeout_minutes: 40,
      tasks: {
        ...file.tasks,
        banking_001: { ...file.tasks.banking_001!, timeout_minutes: 90 },
        sales_accounting: {
          ...file.tasks.sales_accounting!,
          timeout_minutes: 10,
        },
      },
    };
    const runs = expandSuite(withTimeouts, sampleSpec());
    expect(runs.map((r) => [r.task_name, r.timeout_minutes])).toEqual([
      ["banking_001", 90],
      ["sales_accounting", 40],
    ]);
  });

  it("naming tasks selects only those and lifts explicit_only", async () => {
    const runs = expandSuite(sampleSuite(), sampleSpec(), {
      task: ["hidden", "banking_001"],
    });
    expect(runs.map((r) => r.task_name)).toEqual(["hidden", "banking_001"]);
  });

  it("rejects an unknown task", async () => {
    expect(() =>
      expandSuite(sampleSuite(), sampleSpec(), { task: ["nope"] })
    ).toThrow('Unknown task "nope"');
  });

  it("interleave keeps one run per task in a stable order under a fixed draw", async () => {
    const runs = expandSuite(sampleSuite(), sampleSpec());
    expect(interleave(runs, () => 0).map((r) => r.task_name)).toEqual([
      "banking_001",
      "sales_accounting",
    ]);
  });
});
