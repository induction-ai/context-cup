import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { suiteTotals, taskCells } from "../src/lib/aggregate.ts";

const t = (
  task_name: string,
  reward: number | null,
  costCents: number | null,
  turns: number | null,
  error: string | null = null
) => ({
  task_name,
  reward,
  costCents,
  turns,
  error,
});

describe("aggregate", () => {
  it("builds one cell per task, scoring only graded, error-free trials", async () => {
    const cells = taskCells([
      t("b", 1, 10, 4),
      t("b", 0, 30, 6),
      t("a", 1, 20, 5),
      t("a", null, null, null, "boom"),
    ]);
    expect(cells.map((c) => c.task_name)).toEqual(["a", "b"]);
    expect(cells[0]).toEqual({
      task_name: "a",
      n: 2,
      scored: 1,
      errors: 1,
      mean_reward: 1,
      mean_cost_cents: 20,
      mean_turns: 5,
    });
    expect(cells[1]).toEqual({
      task_name: "b",
      n: 2,
      scored: 2,
      errors: 0,
      mean_reward: 0.5,
      mean_cost_cents: 20,
      mean_turns: 5,
    });
  });

  it("scores a job over its done trials only: an errored trial is left out, not a zero", async () => {
    const [cell] = taskCells([
      t("a", 1, 10, 2),
      t("a", null, null, null, "boom"),
    ]);
    expect(cell).toMatchObject({
      n: 2,
      scored: 1,
      errors: 1,
      mean_reward: 1,
      mean_cost_cents: 10,
    });
  });

  it("makes the ALL row the mean of the cells, task-weighted, and null when nothing scored", async () => {
    // Task a has two done trials, task b one: the suite averages the two jobs
    // (1 and 0), not the three trials.
    expect(
      suiteTotals(
        taskCells([t("a", 1, 10, 2), t("a", 1, 10, 2), t("b", 0, 20, 8)])
      )
    ).toEqual({
      task_name: "ALL",
      n: 3,
      scored: 3,
      errors: 0,
      mean_reward: 0.5,
      mean_cost_cents: 15,
      mean_turns: 5,
    });
    expect(
      suiteTotals(taskCells([t("a", 1, 10, 2), t("b", 0, 20, 8)]))
    ).toEqual({
      task_name: "ALL",
      n: 2,
      scored: 2,
      errors: 0,
      mean_reward: 0.5,
      mean_cost_cents: 15,
      mean_turns: 5,
    });
    expect(suiteTotals(taskCells([t("a", null, null, null, "x")]))).toEqual({
      task_name: "ALL",
      n: 1,
      scored: 0,
      errors: 1,
      mean_reward: null,
      mean_cost_cents: null,
      mean_turns: null,
    });
    expect(suiteTotals(taskCells([]))).toEqual({
      task_name: "ALL",
      n: 0,
      scored: 0,
      errors: 0,
      mean_reward: null,
      mean_cost_cents: null,
      mean_turns: null,
    });
  });
});
