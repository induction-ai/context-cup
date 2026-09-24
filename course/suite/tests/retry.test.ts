import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { shortfallRuns, shouldRetryErrors, totalCount } from "../src/retry.ts";
import { sampleRun } from "./helpers.ts";

describe("shouldRetryErrors", () => {
  it("retries a shortfall of up to half the expected trials", async () => {
    expect(shouldRetryErrors(2, 4)).toBe(true);
    expect(shouldRetryErrors(3, 4)).toBe(false);
  });

  it("has nothing to retry without a shortfall", async () => {
    expect(shouldRetryErrors(0, 4)).toBe(false);
  });

  it("does not retry a lone trial that failed", async () => {
    expect(shouldRetryErrors(1, 1)).toBe(false);
  });
});

describe("shortfallRuns", () => {
  const a = sampleRun({ task_name: "a", count: 3 });
  const b = sampleRun({ task_name: "b", count: 2 });

  it("cuts each run to the trials it still owes", async () => {
    const owed = shortfallRuns(
      [a, b],
      new Map([
        ["a", 1],
        ["b", 2],
      ])
    );
    expect(owed.map((r) => [r.task_name, r.count])).toEqual([["a", 2]]);
    expect(totalCount(owed)).toBe(2);
  });

  it("owes a whole run for a task with no done trials", async () => {
    expect(
      shortfallRuns([a, b], new Map()).map((r) => [r.task_name, r.count])
    ).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("owes nothing for a task done more times than asked", async () => {
    expect(shortfallRuns([b], new Map([["b", 3]]))).toEqual([]);
  });
});
