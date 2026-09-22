import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { dropUnsupported, expandSuite, interleave } from "../src/expand.ts";
import { sampleSuite } from "./helpers.ts";

const cell = (r: {
  task_name: string;
  driver_name: string;
  target_name: string;
}) => `${r.task_name}/${r.driver_name}/${r.target_name}`;

describe("expandSuite", () => {
  it("skips explicit-only entries by default", async () => {
    const runs = expandSuite(sampleSuite());
    expect(runs.map(cell)).toEqual([
      "banking_001/base_passthrough/gpt-5.5@medium",
      "sales_accounting/base_passthrough/gpt-5.5@medium",
    ]);
    expect(runs[0]?.count).toBe(2);
    expect(runs[0]?.timeout_minutes).toBe(40);
  });

  it("naming an axis selects only those entries and lifts explicit_only", async () => {
    const runs = expandSuite(sampleSuite(), {
      target: ["claude-sonnet-4-6"],
      driver: ["base_truncate"],
    });
    expect(runs.map(cell)).toEqual([
      "banking_001/base_truncate/claude-sonnet-4-6",
      "sales_accounting/base_truncate/claude-sonnet-4-6",
    ]);
  });

  it("rejects an unknown selection", async () => {
    expect(() => expandSuite(sampleSuite(), { task: ["nope"] })).toThrow(
      'Unknown task "nope"'
    );
  });

  it("interleaves so neighbours are different tasks", async () => {
    const runs = expandSuite(sampleSuite(), {
      driver: ["base_passthrough", "base_truncate"],
    });
    expect(runs).toHaveLength(4);
    const order = interleave(runs, () => 0).map((r) => r.task_name);
    expect(order).toEqual([
      "banking_001",
      "sales_accounting",
      "banking_001",
      "sales_accounting",
    ]);
  });
});

describe("dropUnsupported", () => {
  it("drops cells whose driver lacks the target's provider and reports each pair once", () => {
    const runs = expandSuite(sampleSuite(), {
      target: ["gpt-5.5@medium", "claude-sonnet-4-6"],
    });
    const { runs: kept, skipped } = dropUnsupported(runs, () => ["openai"]);
    expect(kept.every((r) => r.target.provider === "openai")).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(skipped.map((s) => `${s.driver_name}|${s.target_name}`)).toEqual([
      ...new Set(skipped.map((s) => `${s.driver_name}|${s.target_name}`)),
    ]);
    expect(skipped.every((s) => s.provider === "anthropic")).toBe(true);
  });
});
