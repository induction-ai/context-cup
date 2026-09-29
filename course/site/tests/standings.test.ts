import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  BENCHMARK_TASKS,
  disqualifications,
  rankBoard,
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

describe("BENCHMARK_TASKS", () => {
  it("is each suite file’s tasks, less the explicit_only ones", async () => {
    expect(BENCHMARK_TASKS.tau_banking).toHaveLength(97);
    expect(BENCHMARK_TASKS.toolathlon).toHaveLength(107);
    expect(BENCHMARK_TASKS.toolathlon).not.toContain("train_ticket_plan");
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
