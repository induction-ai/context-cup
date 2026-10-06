/**
 * bin/review_driver: the review of a driver PR, as the Driver review workflow
 * runs it, on your own branch.
 *
 *   bin/review_driver                 the static review (static.ts)
 *   bin/review_driver --claude        then, if it passes, Claude Code reads
 *                                     the driver for anything shady
 *                                     (claude.ts)
 *   bin/review_driver --smoke         then, if those pass, the smoke run:
 *                                     SMOKE_SUITES at the reference target
 *                                     (smoke.ts)
 *
 * Each step runs only when the ones before it pass, as in the workflow. The
 * Claude review needs Claude Code, signed in or with ANTHROPIC_API_KEY; it
 * appends CC_REVIEW_INSTRUCTIONS to its prompt when that is set.
 *
 * The static review covers what the checkout at `--root` changes against
 * `--base`: commits, uncommitted edits, and untracked files alike. The smoke
 * run is `bin/suite` on each smoke suite, with up to three retry passes for
 * trials that error, and passes when every trial finishes; it needs the keys
 * `bin/suite` does (OPENAI_API_KEY, and DAYTONA_API_KEY on Daytona).
 *
 * Ends with a PASS or FAIL line and exits 1 on a FAIL. The workflow runs the
 * static review from main against a checkout of the PR's merge commit, with
 * `--base` the merge's first parent, and the smoke run in main with only the
 * driver's directory copied in, with `--base HEAD`.
 * `--output`, `--json_output`, `--claude_output`, and `--smoke_output`
 * write what it posts.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import yargs from "yargs";
import {
  DEFAULT_CLAUDE_BUDGET_USD,
  DEFAULT_CLAUDE_MODEL,
  formatClaudeMarkdown,
  formatClaudeText,
  runClaudeReview,
} from "./claude.ts";
import {
  formatSmokeMarkdown,
  formatSmokeText,
  runSmoke,
  SMOKE_SUITES,
  type SmokeResult,
} from "./smoke.ts";
import {
  errors,
  formatJson,
  formatMarkdown,
  formatText,
  reviewDriverPr,
} from "./static.ts";

function git(root: string, ...args: string[]): string[] {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .usage("$0 [--claude] [--smoke] [--base <ref>]")
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
    .option("claude", {
      type: "boolean",
      default: false,
      describe: "After the static review passes, have Claude Code review it",
    })
    .option("claude_model", {
      type: "string",
      default: DEFAULT_CLAUDE_MODEL,
      describe: "The model the Claude review runs on",
    })
    .option("claude_budget", {
      type: "number",
      default: DEFAULT_CLAUDE_BUDGET_USD,
      describe: "Most the Claude review may spend, in dollars",
    })
    .option("smoke", {
      type: "boolean",
      default: false,
      describe: "After the reviews before it pass, run the smoke suites",
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
    .option("claude_output", {
      type: "string",
      describe: "Write the Claude review as Markdown here",
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
  const passed = ["the static review"];
  const summaries = [formatText(review)];

  if (argv.claude) {
    console.log("\n==> Claude review");
    const claude = await runClaudeReview({
      root,
      driver: review.driver,
      model: argv.claude_model,
      budget_usd: argv.claude_budget,
      extra_instructions: process.env.CC_REVIEW_INSTRUCTIONS,
    });
    if (argv.claude_output) {
      writeFileSync(argv.claude_output, formatClaudeMarkdown(claude));
    }
    summaries.push(formatClaudeText(claude));
    if (claude.flagged) {
      console.log(`\n${summaries.join("\n\n")}`);
      console.log(
        claude.error
          ? "\nFAIL: the Claude review didn’t finish."
          : "\nFAIL: the Claude review flagged the driver."
      );
      process.exitCode = 1;
      return;
    }
    passed.push("the Claude review");
  }

  if (argv.smoke) {
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
    summaries.push(formatSmokeText(review.driver, results));
    const failed = results.filter((r) => !r.ok).map((r) => r.suite);
    if (failed.length > 0) {
      console.log(`\n${summaries.join("\n\n")}`);
      console.log(`\nFAIL: the smoke run failed on ${failed.join(" and ")}.`);
      process.exitCode = 1;
      return;
    }
    passed.push("the smoke run");
  }

  console.log(`\n${summaries.join("\n\n")}`);
  const listed =
    passed.length === 1
      ? passed[0]
      : `${passed.slice(0, -1).join(", ")} and ${passed.at(-1)}`;
  const next =
    argv.claude && argv.smoke
      ? ""
      : " `--claude --smoke` runs the whole review the workflow runs.";
  console.log(`\nPASS: ${listed}.${next}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
