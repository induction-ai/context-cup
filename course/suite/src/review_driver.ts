/**
 * bin/review_driver: the review of a driver PR, as the Driver review workflow
 * runs it, on your own branch.
 *
 *   bin/review_driver                 the static review (review.ts)
 *   bin/review_driver --smoke         then, if it passes, the smoke run:
 *                                     SMOKE_SUITES at the reference target
 *
 * The static review covers what the checkout at `--root` changes against
 * `--base`: commits, uncommitted edits, and untracked files alike. The smoke
 * run is `bin/suite` on each smoke suite, with up to three retry passes for
 * trials that error, and passes when every trial finishes; it needs the keys
 * `bin/suite` does (OPENAI_API_KEY, and DAYTONA_API_KEY on Daytona).
 *
 * Ends with a PASS or FAIL line and exits 1 on a FAIL. The workflow runs the
 * static review from main against a checkout of the PR's merge commit, with
 * `--base` the merge's first parent, and the smoke run in that merge commit.
 * `--output`, `--json_output`, and `--smoke_output` write what it posts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import { execa } from "execa";
import yargs from "yargs";
import {
  errors,
  formatJson,
  formatMarkdown,
  formatSmokeMarkdown,
  formatSmokeText,
  formatText,
  reviewDriverPr,
  SMOKE_SUITES,
  type SmokeResult,
} from "./review.ts";

function git(root: string, ...args: string[]): string[] {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Runs one smoke suite through bin/suite, its output passed through. */
async function runSmoke(
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

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .usage("$0 [--smoke] [--base <ref>]")
    .option("base", {
      type: "string",
      default: "origin/main",
      describe: "What the branch is compared against",
    })
    .option("root", {
      type: "string",
      default: REPO_ROOT,
      describe: "The checkout to review",
    })
    .option("smoke", {
      type: "boolean",
      default: false,
      describe: "After the static review passes, run the smoke suites",
    })
    .option("harbor_env", {
      choices: ["daytona", "docker"],
      default: "daytona",
      describe: "Where the smoke suites run their tasks",
    })
    .option("log_dir", {
      type: "string",
      default: path.join(REPO_ROOT, ".temp", "review"),
      describe: "Where the smoke suites write their logs, one directory each",
    })
    .option("output", {
      type: "string",
      describe: "Write the static review as Markdown here",
    })
    .option("json_output", {
      type: "string",
      describe: "Write the static review as JSON here",
    })
    .option("smoke_output", {
      type: "string",
      describe: "Write the smoke run as Markdown here",
    })
    .strict()
    .parse();

  const root = path.resolve(argv.root);
  if (argv.smoke && root !== REPO_ROOT) {
    throw new Error(
      "--smoke runs the driver from this checkout, so it can’t review another --root"
    );
  }
  const [merge_base] = git(root, "merge-base", argv.base, "HEAD");
  const untracked = git(root, "ls-files", "--others", "--exclude-standard");
  const changed = [
    ...new Set([
      ...git(root, "diff", "--name-only", "--no-renames", merge_base!),
      ...untracked,
    ]),
  ];
  const tracked = [...git(root, "ls-files", "--cached"), ...untracked];

  // What main already has: a PR that changes one of these edits an entry.
  const existing = git(
    root,
    "ls-tree",
    "-d",
    "--name-only",
    merge_base!,
    "drivers/"
  ).map((dir) => path.basename(dir));

  const review = reviewDriverPr({ root, changed, tracked, existing });
  if (argv.output) writeFileSync(argv.output, formatMarkdown(review));
  if (argv.json_output) writeFileSync(argv.json_output, formatJson(review));
  console.log(formatText(review));

  const static_errors = errors(review).length;
  if (static_errors > 0 || !review.driver) {
    console.log(
      `\nFAIL: the static review found ${static_errors === 1 ? "an error" : `${static_errors} errors`}.`
    );
    process.exitCode = 1;
    return;
  }
  if (!argv.smoke) {
    console.log(
      "\nPASS: the static review. Next, `bin/review_driver --smoke` runs the smoke suites the review runs."
    );
    return;
  }

  const results: SmokeResult[] = [];
  for (const suite of SMOKE_SUITES) {
    console.log(`\n==> ${suite}`);
    results.push(
      await runSmoke(suite, review.driver, argv.harbor_env, argv.log_dir)
    );
  }
  if (argv.smoke_output) {
    writeFileSync(
      argv.smoke_output,
      formatSmokeMarkdown(review.driver, results)
    );
  }
  console.log(
    `\n${formatText(review)}\n\n${formatSmokeText(review.driver, results)}`
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.suite);
  if (failed.length > 0) {
    console.log(`\nFAIL: the smoke run failed on ${failed.join(" and ")}.`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS: the static review and the smoke run.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
