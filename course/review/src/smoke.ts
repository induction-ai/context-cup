/** The smoke run of a driver PR (the last step of bin/review_driver): each
 *  smoke suite through bin/suite at the reference target. The driver runs
 *  for real here, in the suite's sandboxes, so the workflow only starts it
 *  once the static and Claude reviews have passed. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import { execa } from "execa";

/** The suites the smoke check runs, at the reference target. */
export const SMOKE_SUITES = ["smoke_tau", "smoke_toolathlon"];

/** One smoke suite's run: it passes when bin/suite does, which is when
 *  every trial finished, whatever its reward. A trial that errors is retried,
 *  up to three more passes, so a flaky sandbox doesn't fail an entry; one that
 *  never finishes does. */
export type SmokeResult = {
  suite: string;
  ok: boolean;
  /** Where bin/suite wrote this suite's logs. */
  log_dir: string;
  /** bin/suite's results table, when it got that far. */
  results?: string;
};

/** Marks the PR comment the workflow keeps updated with the smoke run. */
export const SMOKE_MARKER = "<!-- driver-review:smoke -->";

/** The smoke run as the PR comment the workflow posts. */
export function formatSmokeMarkdown(
  driver: string,
  results: readonly SmokeResult[]
): string {
  const ok = results.every((r) => r.ok);
  const lines = [
    SMOKE_MARKER,
    `## ${ok ? "✅" : "❌"} Smoke run: \`${driver}\``,
    "",
    "Each smoke suite at the reference target. A suite passes when every trial finishes, retrying any that error up to three times; the reward doesn’t matter here.",
  ];
  for (const r of results) {
    lines.push("", `### \`${r.suite}\`: ${r.ok ? "✅ passed" : "❌ failed"}`);
    if (r.results) lines.push("", "```", r.results.trimEnd(), "```");
  }
  if (!ok) {
    lines.push(
      "",
      "Each trial’s error, and every turn’s input and output, are in the run’s `suite-logs` artifact."
    );
  }
  return lines.join("\n") + "\n";
}

/** The smoke run for a terminal. */
export function formatSmokeText(
  driver: string,
  results: readonly SmokeResult[]
): string {
  const lines = [`Smoke run: ${driver}`];
  for (const r of results) {
    lines.push(r.ok ? `  ✓ ${r.suite}` : `  ✗ ${r.suite}: see ${r.log_dir}`);
  }
  return lines.join("\n");
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Runs one smoke suite through bin/suite, its output passed through. */
export async function runSmoke(
  suite: string,
  driver: string,
  harbor_env: string,
  log_root: string
): Promise<SmokeResult> {
  const log_dir = path.join(log_root, suite);
  const before = new Set(subdirs(log_dir));
  // No --target: bin/suite runs the reference target.
  const run = await execa(
    path.join(REPO_ROOT, "bin", "suite"),
    [
      suite,
      "--driver",
      driver,
      "--harbor_env",
      harbor_env,
      "--retry_errors",
      "3",
      "--log_dir",
      log_dir,
    ],
    { stdio: "inherit", reject: false }
  );
  // bin/suite writes each run under a directory named for its suite id.
  const suite_dir = subdirs(log_dir).find((d) => !before.has(d));
  const results_file =
    suite_dir && path.join(log_dir, suite_dir, "results.txt");
  return {
    suite,
    ok: run.exitCode === 0,
    log_dir: path.relative(
      process.cwd(),
      suite_dir ? path.join(log_dir, suite_dir) : log_dir
    ),
    results:
      results_file && existsSync(results_file)
        ? readFileSync(results_file, "utf8")
        : undefined,
  };
}
