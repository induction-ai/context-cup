import {
  getTokenCost,
  resolveModel,
  type CostServiceTier,
} from "@context-cup/model-stats/index.js";
import { TokenCount } from "@context-cup/model-stats/token_count.js";
import { totalCost } from "@context-cup/model-stats/usage_counts.js";

/** Token counts for one model call, as reported in output.json. */
export type CallUsage = {
  input: number;
  cached_input: number;
  cache_write_input: number;
  output: number;
  reasoning_output?: number;
};

/** Strip a litellm-style provider prefix (`openai/gpt-5.5`). */
export function bareModel(model: string): string {
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

function serviceTier(tier: string | null | undefined): CostServiceTier {
  return tier === "priority" || tier === "fast" ? "priority" : "standard";
}

/** Whether the pricing table knows this model (exact, variant, or family). */
export function isPriced(model: string): boolean {
  return resolveModel(bareModel(model)).matched;
}

/** Cost of one call in cents, or null when the model is unknown to the table.
 *  `input` includes cached tokens; cache writes are a subset of the uncached
 *  input. Long-context tiers and priority pricing come from model-stats. */
export function callCostCents(
  model: string,
  usage: CallUsage,
  tier?: string | null
): number | null {
  const name = bareModel(model);
  if (!resolveModel(name).matched) return null;
  const cached = Math.min(usage.cached_input, usage.input);
  const uncached = usage.input - cached;
  const cacheWrite = Math.min(usage.cache_write_input, uncached);
  let cost;
  try {
    cost = getTokenCost(
      {
        model: name,
        input: TokenCount.value(usage.input),
        uncached: TokenCount.value(uncached),
        cached: TokenCount.value(cached),
        output: TokenCount.value(usage.output),
        ...(cacheWrite > 0
          ? { cache_write: TokenCount.value(cacheWrite) }
          : {}),
        ...(usage.reasoning_output
          ? { thinking: TokenCount.value(usage.reasoning_output) }
          : {}),
      },
      serviceTier(tier)
    );
  } catch {
    // The table has no rate for this tier (priority above the long-context
    // cliff, for one): report the call as unpriced rather than guess.
    return null;
  }
  const cents = totalCost(cost).toNumber() * 100;
  return Math.round(cents * 1_000_000) / 1_000_000;
}
