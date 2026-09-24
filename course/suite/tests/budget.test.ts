import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  fallbackBudgetMinutes,
  jobTimeoutMs,
  sandboxAutoStopMinutes,
} from "../src/budget.ts";
import { sampleRun } from "./helpers.ts";

describe("budgets", () => {
  it("gives a job its trial budget plus overhead, once per wave", async () => {
    const run = sampleRun({ count: 4, timeout_minutes: 40 });
    expect(jobTimeoutMs(run, 2, {})).toBe(70 * 2 * 60_000);
    expect(jobTimeoutMs(run, 4, {})).toBe(70 * 60_000);
  });

  it("falls back to 150 minutes when the suite leaves the timeout to harbor", async () => {
    const run = sampleRun({ count: 1, timeout_minutes: null });
    expect(fallbackBudgetMinutes({})).toBe(150);
    expect(jobTimeoutMs(run, 1, {})).toBe(150 * 60_000);
    expect(jobTimeoutMs(run, 1, { SUITE_COMMAND_TIMEOUT_MIN: "90" })).toBe(
      90 * 60_000
    );
    // Zero or less: no deadline.
    expect(jobTimeoutMs(run, 1, { SUITE_COMMAND_TIMEOUT_MIN: "0" })).toBe(0);
  });

  it("stops a leftover sandbox only after its trial's whole budget", async () => {
    expect(sandboxAutoStopMinutes(sampleRun({ timeout_minutes: 40 }), {})).toBe(
      80
    );
    expect(
      sandboxAutoStopMinutes(sampleRun({ timeout_minutes: null }), {})
    ).toBe(160);
    expect(
      sandboxAutoStopMinutes(sampleRun({ timeout_minutes: null }), {
        SUITE_COMMAND_TIMEOUT_MIN: "0",
      })
    ).toBe(120);
  });
});
