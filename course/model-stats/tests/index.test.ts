// Tests for the exported pricing API. This file is owned by context-cup; the
// export never touches tests/.
import { describe, expect, it } from "vitest";
import modelStats from "../src/data/model_stats.json" with { type: "json" };
import {
  cacheRateMultipliers,
  getCachingInfo,
  getTokenCost,
  pickService,
  resolveModel,
} from "../src/index.ts";
import { TokenCount } from "../src/token_count.ts";
import { totalCost, type TokenUsageCounts } from "../src/usage_counts.ts";

function counts(
  model: string,
  u: { input?: number; cached?: number; cache_write?: number; output?: number }
): TokenUsageCounts {
  const input = u.input ?? 0;
  const cached = u.cached ?? 0;
  return {
    model,
    input: TokenCount.value(input),
    uncached: TokenCount.value(input - cached),
    cached: TokenCount.value(cached),
    output: TokenCount.value(u.output ?? 0),
    ...(u.cache_write !== undefined
      ? { cache_write: TokenCount.value(u.cache_write) }
      : {}),
  };
}

const cents = (c: TokenUsageCounts) =>
  totalCost(getTokenCost(c, "standard")).toNumber() * 100;

describe("data", () => {
  it("covers the four public providers only", () => {
    expect(Object.keys(modelStats).sort()).toEqual([
      "anthropic",
      "fireworks",
      "gemini",
      "openai",
    ]);
  });

  it("has the models the suites target", () => {
    for (const model of ["gpt-5.5", "claude-sonnet-4-6", "gemini-3.1-pro"]) {
      expect(resolveModel(model).matched, model).toBe(true);
    }
  });
});

describe("resolution", () => {
  it("matches dated snapshots to their family", () => {
    const r = resolveModel("gpt-5.5-2026-04-23");
    expect(r.matched).toBe(true);
    expect(r.entry.model_family).toBe("gpt-5.5");
  });

  it("falls back for an unknown model and says so", () => {
    const r = resolveModel("gpt-99-turbo");
    expect(r.matched).toBe(false);
    expect(r.entry.model_family).toBeTruthy();
  });

  it("infers the provider from the id", () => {
    expect(pickService("claude-sonnet-4-6")).toBe("anthropic");
    expect(pickService("gemini-3.1-pro")).toBe("gemini");
    expect(pickService("gpt-5.5")).toBe("openai");
  });
});

describe("cost", () => {
  it("bills input and output at list rates", () => {
    // claude-sonnet-4-6: $3 in, $15 out per million.
    expect(
      cents(
        counts("claude-sonnet-4-6", { input: 1_000_000, output: 1_000_000 })
      )
    ).toBeCloseTo(1800, 6);
  });

  it("bills cache reads below the input rate", () => {
    const plain = cents(counts("gpt-5.5", { input: 100_000 }));
    const cached = cents(
      counts("gpt-5.5", { input: 100_000, cached: 100_000 })
    );
    expect(cached).toBeLessThan(plain);
    expect(cached).toBeGreaterThan(0);
  });

  it("applies the long-context cliff to the whole prompt", () => {
    const under = cents(counts("gpt-5.5", { input: 272_000 }));
    const over = cents(counts("gpt-5.5", { input: 272_001 }));
    // One extra token costs far more than one token's worth: the tier flipped.
    expect(over - under).toBeGreaterThan((under / 272_000) * 1000);
  });

  it("reports cache rate multipliers and caching mechanisms", () => {
    const m = cacheRateMultipliers("claude-sonnet-4-6");
    expect(m.cached_rate_multiplier).toBeCloseTo(0.1, 6);
    expect(m.cache_write_rate_multiplier).toBeCloseTo(1.25, 6);
    expect(getCachingInfo("claude-sonnet-4-6").caching.cache_modes).toContain(
      "breakpoints"
    );
  });
});
