import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  jobMeanCost,
  jobScore,
  mean,
  scoredTrials,
  suiteMean,
} from "../src/scoring.ts";

const done = (reward: number, cost_cents: number | null = 10) => ({
  reward,
  error: null,
  cost_cents,
});
const errored = { reward: null, error: "timed out", cost_cents: 3 };

describe("scoring", () => {
  it("means are null over nothing", async () => {
    expect(mean([])).toBeNull();
    expect(jobScore([])).toBeNull();
    expect(jobMeanCost([])).toBeNull();
    expect(suiteMean([])).toBeNull();
    expect(suiteMean([null, null])).toBeNull();
  });

  it("a job scores over its done trials only: one done at 1.0 plus one errored is 1.0, not 0.5", async () => {
    const trials = [done(1), errored];
    expect(scoredTrials(trials)).toHaveLength(1);
    expect(jobScore(trials)).toBe(1);
    // The errored trial's cost is not a job cost either.
    expect(jobMeanCost(trials)).toBe(10);
    expect(jobScore([errored])).toBeNull();
    expect(jobMeanCost([errored])).toBeNull();
  });

  it("a done trial without a price is skipped for cost, not counted as free", async () => {
    expect(jobMeanCost([done(1, 10), done(0, null)])).toBe(10);
    expect(jobScore([done(1, 10), done(0, null)])).toBe(0.5);
  });

  it("a suite is the mean of its jobs' scores, job-weighted, skipping jobs without one", async () => {
    expect(suiteMean([1, 0])).toBe(0.5);
    expect(suiteMean([1, null, 0.5])).toBe(0.75);
  });
});
