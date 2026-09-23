import { writeFileSync } from "node:fs";
import type { SuiteRun } from "./expand.ts";
import type { ParsedTrial } from "./ingest.ts";
import { jobMeanCost, jobScore, mean, suiteMean } from "./scoring.ts";
import { describeTarget, type Target } from "./targets.ts";

export type CellResult = {
  task_name: string;
  /** Trials harbor produced. */
  n: number;
  /** Trials with a reward. */
  scored: number;
  errors: number;
  mean_reward: number | null;
  /** Over priced trials only. */
  mean_cost_cents: number | null;
  mean_turns: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
};

export type SuiteResults = {
  suite_id: string;
  suite_name: string;
  driver_name: string;
  target_name: string;
  target: Target;
  /** Trials per task. */
  count: number;
  started_at: string;
  finished_at: string;
  git_sha: string | null;
  harbor_env: string;
  jobs: Array<{ job_id: string; ok: boolean; error: string | null }>;
  cells: CellResult[];
  /** The suite's score: the mean of the cells' mean rewards (one cell is one
   *  job), job-weighted. See scoring.ts. */
  score: number | null;
  /** The mean of the cells' mean costs, on the same terms. */
  mean_cost_cents: number | null;
};

export function summarizeCell(
  run: SuiteRun,
  trials: ParsedTrial[]
): CellResult {
  const turns = trials.flatMap((t) => (t.turns === null ? [] : [t.turns]));
  return {
    task_name: run.task_name,
    n: trials.length,
    scored: trials.filter((t) => t.reward !== null && t.error === null).length,
    errors: trials.filter((t) => t.error !== null).length,
    mean_reward: jobScore(trials),
    mean_cost_cents: jobMeanCost(trials),
    mean_turns: mean(turns),
    total_input_tokens: trials.reduce((s, t) => s + t.totals.input, 0),
    total_output_tokens: trials.reduce((s, t) => s + t.totals.output, 0),
  };
}

/** The suite's score and cost from its cells: the mean of the job means. */
export function suiteTotals(cells: readonly CellResult[]): {
  score: number | null;
  mean_cost_cents: number | null;
} {
  return {
    score: suiteMean(cells.map((c) => c.mean_reward)),
    mean_cost_cents: suiteMean(cells.map((c) => c.mean_cost_cents)),
  };
}

export function writeResults(file: string, results: SuiteResults): void {
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
}

function fmt(value: number | null, digits: number): string {
  return value === null ? "-" : value.toFixed(digits);
}

/** The one line above the table saying what the whole run drove. */
export function resultsHeader(
  results: Pick<
    SuiteResults,
    "driver_name" | "target_name" | "target" | "count"
  >
): string {
  return `driver: ${results.driver_name}  target: ${results.target_name} (${describeTarget(results.target)})  count: ${results.count}`;
}

/** A fixed-width table: one line per task, then one for all of them. */
export function resultsTable(cells: CellResult[]): string {
  const header = ["task", "trials", "done", "err", "reward", "cost¢", "turns"];
  const rows = cells.map((c) => [
    c.task_name,
    String(c.n),
    String(c.scored),
    String(c.errors),
    fmt(c.mean_reward, 2),
    fmt(c.mean_cost_cents, 1),
    fmt(c.mean_turns, 1),
  ]);
  if (cells.length > 0) {
    const totals = suiteTotals(cells);
    rows.push([
      "ALL",
      String(cells.reduce((s, c) => s + c.n, 0)),
      String(cells.reduce((s, c) => s + c.scored, 0)),
      String(cells.reduce((s, c) => s + c.errors, 0)),
      fmt(totals.score, 3),
      fmt(totals.mean_cost_cents, 1),
      "",
    ]);
  }
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length))
  );
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}
