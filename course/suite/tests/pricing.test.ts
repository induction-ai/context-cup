import { describe, expect, it } from "vitest";
import { bareModel, callCostCents, isPriced } from "../src/pricing.ts";

const usage = (u: Partial<Parameters<typeof callCostCents>[1]>) => ({
  input: 0,
  cached_input: 0,
  cache_write_input: 0,
  output: 0,
  ...u,
});

describe("pricing via model-stats", () => {
  it("prices plain input and output at list rates", () => {
    // claude-sonnet-4-6: $3 / $15 per million.
    const cents = callCostCents(
      "claude-sonnet-4-6",
      usage({ input: 1_000_000, output: 1_000_000 })
    );
    expect(cents).toBeCloseTo(1800, 6);
  });

  it("bills cached input at the cache-read rate", () => {
    const plain = callCostCents("gpt-5.5", usage({ input: 1_000_000 }))!;
    const cached = callCostCents(
      "gpt-5.5",
      usage({ input: 1_000_000, cached_input: 1_000_000 })
    )!;
    expect(cached).toBeLessThan(plain);
    expect(cached).toBeGreaterThan(0);
  });

  it("resolves dated snapshots and litellm prefixes to the family", () => {
    expect(bareModel("openai/gpt-5.5-2026-04-23")).toBe("gpt-5.5-2026-04-23");
    expect(isPriced("openai/gpt-5.5-2026-04-23")).toBe(true);
    expect(
      callCostCents("openai/gpt-5.5-2026-04-23", usage({ input: 1000 }))
    ).toBe(callCostCents("gpt-5.5", usage({ input: 1000 })));
  });

  it("returns null for a model the table cannot match", () => {
    expect(isPriced("totally-made-up-model-9")).toBe(false);
    expect(callCostCents("totally-made-up-model-9", usage({ input: 10 }))).toBe(
      null
    );
  });

  it("charges priority tier more than standard when the model has one", () => {
    // Under the long-context cliff, where OpenAI offers priority pricing.
    const standard = callCostCents("gpt-5.5", usage({ input: 100_000 }))!;
    const priority = callCostCents(
      "gpt-5.5",
      usage({ input: 100_000 }),
      "priority"
    )!;
    expect(priority).toBeGreaterThan(standard);
  });

  it("leaves a call unpriced when the table has no rate for its tier", () => {
    // Priority pricing is not offered above the 272k cliff.
    expect(
      callCostCents("gpt-5.5", usage({ input: 1_000_000 }), "priority")
    ).toBe(null);
  });
});
