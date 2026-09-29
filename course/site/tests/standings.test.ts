import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  BENCHMARK_TASKS,
  disqualifications,
  rankBoard,
  rankCombined,
  type Baseline,
  type BenchmarkSuite,
  type Entry,
} from "../src/lib/standings.ts";

const e = (
  driver_name: string,
  mean_reward: number | null,
  mean_cost_cents: number | null
): Entry => ({
  driver_name,
  suite_id: `s_${driver_name}`,
  suite_started_at: new Date("2026-09-25T00:00:00Z"),
  trials: 3,
  scored: 3,
  errors: 0,
  tasks_scored: 3,
  mean_reward,
  mean_cost_cents,
});

// Ten tasks: a mean task cost of 10¢ is a $1.00 run.
const base = { score: 0.6, run_cents: 1000 };
const order = (entries: Entry[]) =>
  rankBoard(entries, base, 10).standings.map((s) => [s.driver_name, s.kind]);

describe("rankBoard", () => {
  it("leads with the cheapest driver that reaches the baseline's score for a cheaper run", async () => {
    const board = rankBoard(
      [
        // Matching the baseline's score is enough, judged to two decimals.
        e("edge", 0.595, 90),
        e("cheap", 0.6, 50),
        // Better score but dearer than cheap: qualifies, ranked by cost.
        e("strong", 0.8, 70),
        // Anything that rounds under it is not, however cheap.
        e("close", 0.5949, 10),
      ],
      base,
      10
    );
    expect(board.bar).toBe(0.6);
    expect(board.budget).toBe(1000);
    expect(board.standings.map((s) => [s.driver_name, s.kind])).toEqual([
      ["cheap", "leader"],
      ["strong", "qualifies"],
      ["edge", "qualifies"],
      ["close", "below_bar"],
    ]);
    expect(board.standings.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    expect(board.standings[0]!.run_cents).toBe(500);
    expect(board.standings[0]!.cost_ratio).toBeCloseTo(0.5, 9);
    expect(board.standings[1]!.score_ratio).toBeCloseTo(0.8 / 0.6, 9);
  });

  it("has no leader when nothing clears the bar for less, and ranks the rest cost-first then score-first", async () => {
    expect(
      order([
        e("pricey", 0.9, 300),
        // A run costing exactly the baseline's is not cheaper.
        e("tie", 0.6, 100),
        e("weak_cheap", 0.3, 5),
        e("weak_better", 0.5, 400),
        e("nothing", null, null),
      ])
    ).toEqual([
      ["tie", "costs_more"],
      ["pricey", "costs_more"],
      ["weak_better", "below_bar"],
      ["weak_cheap", "below_bar"],
      ["nothing", "unscored"],
    ]);
  });

  it("measures nothing without a baseline, listing by score", async () => {
    const board = rankBoard(
      [e("a", 0.4, 10), e("b", 0.7, 90), e("c", null, null)],
      null,
      10
    );
    expect(board.bar).toBeNull();
    expect(board.budget).toBeNull();
    expect(board.standings.map((s) => [s.driver_name, s.kind])).toEqual([
      ["b", "no_bar"],
      ["a", "no_bar"],
      ["c", "unscored"],
    ]);
  });

  it("does not let a driver with an unknown cost qualify", async () => {
    expect(order([e("free", 0.9, null)])).toEqual([["free", "costs_more"]]);
  });
});

describe("rankCombined", () => {
  // Ten tasks a board, so a mean task cost is a tenth of a run's.
  const bases: Record<BenchmarkSuite, Baseline> = {
    tau_banking: { score: 0.44, run_cents: 4000 },
    toolathlon: { score: 0.6, run_cents: 2500 },
  };
  /** Each driver's [score, run cents] on each benchmark, or null for none. */
  type Runs = Record<string, Record<BenchmarkSuite, [number, number] | null>>;
  const combined = (runs: Runs, b = bases) => {
    const board = (suite: BenchmarkSuite) =>
      rankBoard(
        Object.entries(runs).flatMap(([name, r]) =>
          r[suite] ? [e(name, r[suite][0], r[suite][1] / 10)] : []
        ),
        b[suite],
        10
      );
    return rankCombined({
      tau_banking: board("tau_banking"),
      toolathlon: board("toolathlon"),
    });
  };

  it("leads with the qualifier whose cost ratios have the lowest geometric mean", async () => {
    const board = combined({
      // Half the baseline's cost on one, 95% on the other: √0.475 ≈ 0.689.
      specialist: { tau_banking: [0.5, 2000], toolathlon: [0.6, 2375] },
      // 70% on both: 0.7. The mean of the ratios would put it first.
      balanced: { tau_banking: [0.5, 2800], toolathlon: [0.6, 1750] },
    });
    expect(board.map((c) => [c.driver_name, c.kind])).toEqual([
      ["specialist", "leader"],
      ["balanced", "qualifies"],
    ]);
    expect(board[0]!.cost_ratio).toBeCloseTo(Math.sqrt(0.5 * 0.95), 9);
    expect(board[1]!.cost_ratio).toBeCloseTo(0.7, 9);
    // The worse of 0.5 / 0.44 and 0.6 / 0.6.
    expect(board[0]!.score_ratio).toBeCloseTo(1, 9);
  });

  it("orders the same whatever the baselines cost", async () => {
    const runs: Runs = {
      a: { tau_banking: [0.5, 1000], toolathlon: [0.7, 900] },
      b: { tau_banking: [0.5, 300], toolathlon: [0.7, 2000] },
      c: { tau_banking: [0.5, 700], toolathlon: [0.7, 1200] },
    };
    const names = (b: Record<BenchmarkSuite, Baseline>) =>
      combined(runs, b).map((c) => c.driver_name);
    expect(names(bases)).toEqual(["b", "c", "a"]);
    expect(
      names({
        tau_banking: { score: 0.44, run_cents: 1500 },
        toolathlon: { score: 0.6, run_cents: 9000 },
      })
    ).toEqual(["b", "c", "a"]);
  });

  it("qualifies a driver only on every benchmark, and ranks the rest cost-first then score-first", async () => {
    expect(
      combined({
        // Cheaper on tau, dearer on toolathlon: costs more overall.
        over: { tau_banking: [0.5, 1000], toolathlon: [0.7, 3000] },
        pricier: { tau_banking: [0.5, 5000], toolathlon: [0.7, 3000] },
        // Under the bar on toolathlon, however cheap.
        weak: { tau_banking: [0.5, 100], toolathlon: [0.3, 100] },
        weaker: { tau_banking: [0.2, 100], toolathlon: [0.7, 100] },
        // No toolathlon run at all.
        solo: { tau_banking: [0.9, 100], toolathlon: null },
        good: { tau_banking: [0.44, 3900], toolathlon: [0.6, 2400] },
      }).map((c) => [c.driver_name, c.kind])
    ).toEqual([
      ["good", "leader"],
      ["over", "costs_more"],
      ["pricier", "costs_more"],
      ["weak", "below_bar"],
      ["weaker", "below_bar"],
      ["solo", "incomplete"],
    ]);
  });
});

describe("BENCHMARK_TASKS", () => {
  it("is each suite file’s tasks, less the explicit_only ones", async () => {
    expect(BENCHMARK_TASKS.tau_banking).toHaveLength(97);
    expect(BENCHMARK_TASKS.toolathlon).toHaveLength(107);
  });
});

describe("disqualifications", () => {
  const good = {
    name: "tau_banking",
    target_name: "gpt-6-sol@medium",
    finished_at: new Date("2026-09-25T00:00:00Z"),
    min_task_done: 2,
    missing_tasks: 0,
  };

  it("clears a finished benchmark run at the reference target with enough done trials", async () => {
    expect(disqualifications(good)).toEqual([]);
    expect(disqualifications({ ...good, name: "toolathlon" })).toEqual([]);
  });

  it("gives every reason a run falls short", async () => {
    expect(
      disqualifications({
        name: "smoke_tau",
        target_name: "gpt-5.5@medium",
        finished_at: null,
        min_task_done: 1,
        missing_tasks: 0,
      })
    ).toEqual([
      "not a benchmark suite",
      "target isn’t gpt-6-sol@medium",
      "not finished",
      "a task has 1 completed trial, needs 2",
    ]);
    expect(
      disqualifications({ ...good, name: "toolathlon", missing_tasks: 106 })
    ).toEqual(["ran 1 of the suite’s 107 tasks, not a full run"]);
    expect(disqualifications({ ...good, min_task_done: 0 })).toEqual([
      "a task has 0 completed trials, needs 2",
    ]);
    expect(disqualifications({ ...good, min_task_done: null })).toEqual([
      "no tasks",
    ]);
  });
});
