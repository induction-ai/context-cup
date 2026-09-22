import { writeFileSync } from "node:fs";
import type { SuiteRun } from "./expand.ts";
import type { ParsedTrial } from "./ingest.ts";

export type CellResult = {
  task_name: string;
  driver_name: string;
  target_name: string;
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
  started_at: string;
  finished_at: string;
  git_sha: string | null;
  harbor_env: string;
  jobs: Array<{ job_id: string; ok: boolean; error: string | null }>;
  cells: CellResult[];
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarizeCell(
  run: SuiteRun,
  trials: ParsedTrial[]
): CellResult {
  const rewards = trials.flatMap((t) => (t.reward === null ? [] : [t.reward]));
  const costs = trials.flatMap((t) =>
    t.cost_cents === null ? [] : [t.cost_cents]
  );
  const turns = trials.flatMap((t) => (t.turns === null ? [] : [t.turns]));
  return {
    task_name: run.task_name,
    driver_name: run.driver_name,
    target_name: run.target_name,
    n: trials.length,
    scored: rewards.length,
    errors: trials.filter((t) => t.error !== null).length,
    mean_reward: mean(rewards),
    mean_cost_cents: mean(costs),
    mean_turns: mean(turns),
    total_input_tokens: trials.reduce((s, t) => s + t.totals.input, 0),
    total_output_tokens: trials.reduce((s, t) => s + t.totals.output, 0),
  };
}

export function writeResults(file: string, results: SuiteResults): void {
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
}

function fmt(value: number | null, digits: number): string {
  return value === null ? "-" : value.toFixed(digits);
}

/** A fixed-width table: one line per cell, then one per driver × target. */
export function resultsTable(cells: CellResult[]): string {
  const header = [
    "task",
    "driver",
    "target",
    "n",
    "scored",
    "err",
    "reward",
    "cost¢",
    "turns",
  ];
  const rows = cells.map((c) => [
    c.task_name,
    c.driver_name,
    c.target_name,
    String(c.n),
    String(c.scored),
    String(c.errors),
    fmt(c.mean_reward, 2),
    fmt(c.mean_cost_cents, 1),
    fmt(c.mean_turns, 1),
  ]);
  const rollup = new Map<string, CellResult[]>();
  for (const c of cells) {
    const key = `${c.driver_name}\u0000${c.target_name}`;
    rollup.set(key, [...(rollup.get(key) ?? []), c]);
  }
  for (const group of rollup.values()) {
    const first = group[0]!;
    const scored = group.reduce((s, c) => s + c.scored, 0);
    const reward =
      scored === 0
        ? null
        : group.reduce((s, c) => s + (c.mean_reward ?? 0) * c.scored, 0) /
          scored;
    const priced = group.filter((c) => c.mean_cost_cents !== null);
    const cost =
      priced.length === 0 ? null : mean(priced.map((c) => c.mean_cost_cents!));
    rows.push([
      "ALL",
      first.driver_name,
      first.target_name,
      String(group.reduce((s, c) => s + c.n, 0)),
      String(scored),
      String(group.reduce((s, c) => s + c.errors, 0)),
      fmt(reward, 3),
      fmt(cost, 1),
      "",
    ]);
  }
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length))
  );
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i < 3 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}
