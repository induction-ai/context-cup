/** The Claude review of a driver PR: Claude Code reads the entry for
 *  anything shady before the smoke run lets it near the review keys. The
 *  static review (static.ts) holds an entry to published rules; this one
 *  judges intent, so its instructions stay general and nothing in the repo
 *  lists what it looks for. Maintainers can add instructions of their own
 *  that stay out of the repo: CC_REVIEW_INSTRUCTIONS, appended to the
 *  prompt.
 *
 *  Claude runs restricted: read-only file tools, confined to the checkout,
 *  no commands, no web, no MCP servers, and a spending cap. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import z from "zod";

const PROMPT_FILE = path.join(import.meta.dirname, "claude_prompt.md");

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const DEFAULT_CLAUDE_BUDGET_USD = 5;

const zFinding = z.object({
  blocking: z.boolean(),
  file: z.string(),
  line: z.number().int().optional(),
  issue: z.string(),
});

const zVerdict = z.object({
  verdict: z.enum(["clean", "flagged"]),
  summary: z.string(),
  findings: z.array(zFinding),
});

/** What Claude must answer with, as the CLI's --json-schema. */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["clean", "flagged"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          blocking: { type: "boolean" },
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
        },
        required: ["blocking", "file", "issue"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};

export type ClaudeFinding = z.infer<typeof zFinding>;

export type ClaudeReview = {
  driver: string;
  /** Flagged when Claude says so or names any blocking finding; a review
   *  that didn't finish is flagged too, never passed by default. */
  flagged: boolean;
  summary: string;
  findings: ClaudeFinding[];
  model: string;
  cost_usd?: number;
  /** Why the review didn't finish, when it didn't. */
  error?: string;
};

/** The prompt: the public instructions for this driver, then the
 *  maintainers' own when there are any. */
export function buildPrompt(driver: string, extra?: string): string {
  const prompt = readFileSync(PROMPT_FILE, "utf8").replaceAll(
    "{{driver}}",
    driver
  );
  const more = extra?.trim();
  return more
    ? `${prompt}\nThe maintainers add these instructions:\n\n${more}\n`
    : prompt;
}

/** The CLI's arguments for a restricted, structured, capped review. */
export function claudeArgs(model: string, budget_usd: number): string[] {
  return [
    "-p",
    "--restricted",
    "--tools",
    "Read",
    "Grep",
    "Glob",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--model",
    model,
    "--max-budget-usd",
    String(budget_usd),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(VERDICT_SCHEMA),
  ];
}

/** The review from the CLI's `--output-format json` result. */
export function parseClaudeResult(
  driver: string,
  model: string,
  stdout: string
): ClaudeReview {
  const failed = (error: string, cost_usd?: number): ClaudeReview => ({
    driver,
    flagged: true,
    summary: "",
    findings: [],
    model,
    cost_usd,
    error,
  });
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return failed(
      `Claude Code printed no result: ${stdout.trim().slice(0, 300)}`
    );
  }
  const cost_usd =
    typeof result.total_cost_usd === "number"
      ? result.total_cost_usd
      : undefined;
  if (result.is_error || result.subtype !== "success") {
    return failed(
      `Claude Code stopped (${String(result.subtype)}): ${String(result.result ?? "").slice(0, 300)}`,
      cost_usd
    );
  }
  const parsed = zVerdict.safeParse(result.structured_output);
  if (!parsed.success) {
    return failed("Claude Code answered without a verdict.", cost_usd);
  }
  const { verdict, summary, findings } = parsed.data;
  return {
    driver,
    flagged: verdict === "flagged" || findings.some((f) => f.blocking),
    summary,
    findings,
    model,
    cost_usd,
  };
}

/** Runs the review in `root`, the checkout holding `drivers/<driver>/`.
 *  Claude Code must be on PATH and signed in, or have ANTHROPIC_API_KEY. */
export async function runClaudeReview(inputs: {
  root: string;
  driver: string;
  model?: string;
  budget_usd?: number;
  extra_instructions?: string;
}): Promise<ClaudeReview> {
  const model = inputs.model ?? DEFAULT_CLAUDE_MODEL;
  const budget = inputs.budget_usd ?? DEFAULT_CLAUDE_BUDGET_USD;
  let spent = 0;
  let review: ClaudeReview | undefined;
  // Claude now and then writes a verdict that isn't valid JSON (code quoted
  // into a finding, badly escaped) until the CLI stops retrying. A second
  // review usually comes back whole; a second failure stands, flagged.
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await execa("claude", claudeArgs(model, budget - spent), {
      cwd: inputs.root,
      input: buildPrompt(inputs.driver, inputs.extra_instructions),
      reject: false,
    });
    if (run.failed && !run.stdout) {
      const reason =
        (run as { code?: string }).code === "ENOENT"
          ? "Claude Code isn’t installed: see https://docs.claude.com/en/docs/claude-code"
          : `Claude Code failed: ${run.stderr.trim().slice(0, 300)}`;
      return {
        driver: inputs.driver,
        flagged: true,
        summary: "",
        findings: [],
        model,
        error: reason,
      };
    }
    review = parseClaudeResult(inputs.driver, model, run.stdout);
    spent += review.cost_usd ?? 0;
    review.cost_usd = spent;
    if (!review.error?.includes(MALFORMED_VERDICT) || spent >= budget) break;
  }
  return review!;
}

/** The CLI's result subtype when Claude never produced a valid verdict. */
const MALFORMED_VERDICT = "error_max_structured_output_retries";

/** Marks the PR comment the workflow keeps updated with this review. */
export const CLAUDE_MARKER = "<!-- driver-review:claude -->";

function where(f: ClaudeFinding): string {
  return `${f.file}${f.line ? `:${f.line}` : ""}`;
}

/** The review as the PR comment the workflow posts. */
export function formatClaudeMarkdown(review: ClaudeReview): string {
  const lines = [CLAUDE_MARKER];
  if (review.error) {
    lines.push(
      `## ❌ Claude review: \`${review.driver}\` didn’t finish`,
      "",
      review.error
    );
  } else {
    lines.push(
      `## ${review.flagged ? "❌" : "✅"} Claude review: \`${review.driver}\` ${review.flagged ? "flagged" : "clean"}`,
      "",
      review.summary
    );
    const blocking = review.findings.filter((f) => f.blocking);
    const notes = review.findings.filter((f) => !f.blocking);
    if (blocking.length > 0) {
      lines.push("", "### Blocking", "");
      for (const f of blocking) lines.push(`- ❌ \`${where(f)}\`: ${f.issue}`);
    }
    if (notes.length > 0) {
      lines.push("", "### Notes", "");
      for (const f of notes) lines.push(`- ⚠️ \`${where(f)}\`: ${f.issue}`);
    }
  }
  const cost =
    review.cost_usd === undefined ? "" : ` · $${review.cost_usd.toFixed(2)}`;
  lines.push("", `<sub>${review.model}${cost}</sub>`);
  return lines.join("\n") + "\n";
}

/** The review for a terminal. */
export function formatClaudeText(review: ClaudeReview): string {
  if (review.error) {
    return `Claude review: ${review.driver}\n  ✗ ${review.error}`;
  }
  const lines = [
    `Claude review: ${review.driver} (${review.flagged ? "flagged" : "clean"})`,
    `  ${review.summary}`,
  ];
  for (const f of review.findings) {
    lines.push(`  ${f.blocking ? "✗" : "!"} ${where(f)}: ${f.issue}`);
  }
  return lines.join("\n");
}
