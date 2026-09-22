import {
  describe,
  expect,
  it,
  vi,
} from "@context-cup/shared/test_helpers/index.js";
import { parseSuiteFile } from "../src/keys.ts";
import { sampleSuite } from "./helpers.ts";

describe("suite files", () => {
  it("parses a suite and fills defaults", async () => {
    const file = parseSuiteFile({
      suite_name: "x",
      targets: { t: { provider: "openai", model: "gpt-5.5" } },
      drivers: { base_passthrough: {} },
      tasks: {
        banking_047: { runner: "tau3", tau3: { customer: "banking_047" } },
      },
    });
    expect(file.concurrency).toBe(8);
    expect(file.timeout_minutes).toBe(40);
    expect(file.drivers.base_passthrough?.count).toBe(1);
    expect(file.tasks.banking_047?.runner).toBe("tau3");
  });

  it("rejects a driver that is not a workspace package", async () => {
    expect(() =>
      parseSuiteFile({ ...sampleSuite(), drivers: { nope: {} } })
    ).toThrow('Unknown driver "nope"');
  });

  it("rejects an unknown task", async () => {
    expect(() =>
      parseSuiteFile(
        {
          ...sampleSuite(),
          tasks: {
            banking_009: { runner: "tau3", tau3: { customer: "banking_009" } },
          },
        },
        { checkDrivers: false }
      )
    ).toThrow("Unknown tau3 customer");
    expect(() =>
      parseSuiteFile(
        { ...sampleSuite(), tasks: { not_a_task: { runner: "toolathlon" } } },
        { checkDrivers: false }
      )
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
