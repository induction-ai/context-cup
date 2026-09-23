import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { parseSuiteFile } from "../src/keys.ts";
import { sampleSuite } from "./helpers.ts";

describe("suite files", () => {
  it("parses a suite and fills defaults", async () => {
    const file = parseSuiteFile({
      suite_name: "x",
      tasks: {
        banking_047: { runner: "tau3", tau3: { customer: "banking_047" } },
      },
    });
    expect(file.concurrency).toBe(8);
    expect(file.timeout_minutes).toBe(40);
    expect(file.tasks.banking_047?.runner).toBe("tau3");
  });

  it("is only tasks and how hard to run them: drivers and targets are launch choices", async () => {
    expect(() =>
      parseSuiteFile({ ...sampleSuite(), drivers: { base_passthrough: {} } })
    ).toThrow();
    expect(() =>
      parseSuiteFile({
        ...sampleSuite(),
        targets: { t: { provider: "openai", model: "m" } },
      })
    ).toThrow();
  });

  it("rejects an unknown task", async () => {
    expect(() =>
      parseSuiteFile({
        ...sampleSuite(),
        tasks: {
          banking_009: { runner: "tau3", tau3: { customer: "banking_009" } },
        },
      })
    ).toThrow("Unknown tau3 customer");
    expect(() =>
      parseSuiteFile({
        ...sampleSuite(),
        tasks: { not_a_task: { runner: "toolathlon" } },
      })
    ).toThrow("Unknown toolathlon task");
  });

  it("every checked-in suite file parses", async () => {
    const { listSuiteKeys, loadSuiteFile } = await import("../src/keys.ts");
    const keys = listSuiteKeys();
    expect(keys).toEqual([
      "smoke_tau",
      "smoke_toolathlon",
      "tau_banking",
      "toolathlon",
      "toolathlon_local",
    ]);
    expect(Object.keys(loadSuiteFile("tau_banking").file.tasks)).toHaveLength(
      97
    );
    expect(Object.keys(loadSuiteFile("toolathlon").file.tasks)).toHaveLength(
      108
    );
  });
});
