import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  buildPrompt,
  CLAUDE_MARKER,
  claudeArgs,
  formatClaudeMarkdown,
  formatClaudeText,
  parseClaudeResult,
} from "../src/claude.ts";

function result(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.42,
    ...fields,
  });
}

describe("buildPrompt", () => {
  it("names the driver, and appends the maintainers' instructions", async () => {
    const prompt = buildPrompt("keep_recent");
    expect(prompt).toContain("`drivers/keep_recent/`");
    expect(prompt).not.toContain("{{driver}}");
    expect(prompt).not.toContain("The maintainers add");
    expect(buildPrompt("keep_recent", "  Look closely at X.\n")).toMatch(
      /The maintainers add these instructions:\n\nLook closely at X\.\n$/
    );
    expect(buildPrompt("keep_recent", "   ")).toBe(prompt);
  });
});

describe("claudeArgs", () => {
  it("runs restricted, read-only, capped, with a verdict schema", async () => {
    const args = claudeArgs("claude-opus-5-5", 5);
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--restricted", "--strict-mcp-config"])
    );
    const tools = args.slice(
      args.indexOf("--tools") + 1,
      args.indexOf("--tools") + 4
    );
    expect(tools).toEqual(["Read", "Grep", "Glob"]);
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("5");
  });
});

describe("parseClaudeResult", () => {
  it("passes a clean verdict", async () => {
    const review = parseClaudeResult(
      "keep_recent",
      "m",
      result({
        structured_output: {
          verdict: "clean",
          summary: "Clips tool results.",
          findings: [
            {
              blocking: false,
              file: "drivers/keep_recent/driver.py",
              issue: "Note.",
            },
          ],
        },
      })
    );
    expect(review).toMatchObject({ flagged: false, cost_usd: 0.42 });
    expect(review.error).toBeUndefined();
  });

  it("flags a blocking finding even under a clean verdict", async () => {
    const review = parseClaudeResult(
      "keep_recent",
      "m",
      result({
        structured_output: {
          verdict: "clean",
          summary: "s",
          findings: [{ blocking: true, file: "f", line: 3, issue: "i" }],
        },
      })
    );
    expect(review.flagged).toBe(true);
  });

  it("flags a review that didn't finish, whatever the reason", async () => {
    const budget = parseClaudeResult(
      "d",
      "m",
      result({ subtype: "error_max_budget_usd", is_error: true })
    );
    expect(budget).toMatchObject({ flagged: true, cost_usd: 0.42 });
    expect(budget.error).toContain("error_max_budget_usd");
    expect(parseClaudeResult("d", "m", "not json").flagged).toBe(true);
    expect(
      parseClaudeResult(
        "d",
        "m",
        result({ structured_output: { verdict: "maybe" } })
      ).error
    ).toBe("Claude Code answered without a verdict.");
  });
});

describe("formatting", () => {
  const review = {
    driver: "keep_recent",
    flagged: true,
    summary: "Clips tool results; setup.sh does more than install.",
    findings: [
      {
        blocking: true,
        file: "drivers/keep_recent/setup.sh",
        line: 4,
        issue: "Starts a background process.",
      },
      {
        blocking: false,
        file: "drivers/keep_recent/driver.py",
        issue: "Tuned threshold.",
      },
    ],
    model: "claude-opus-5-5",
    cost_usd: 1.234,
  };

  it("writes the PR comment", async () => {
    const markdown = formatClaudeMarkdown(review);
    expect(markdown.split("\n").slice(0, 3)).toEqual([
      CLAUDE_MARKER,
      "## ❌ Claude review: `keep_recent` flagged",
      "",
    ]);
    expect(markdown).toContain(
      "### Blocking\n\n- ❌ `drivers/keep_recent/setup.sh:4`: Starts a background process."
    );
    expect(markdown).toContain(
      "### Notes\n\n- ⚠️ `drivers/keep_recent/driver.py`: Tuned threshold."
    );
    expect(markdown).toContain("<sub>claude-opus-5-5 · $1.23</sub>");
  });

  it("writes a terminal summary", async () => {
    expect(formatClaudeText(review).split("\n")).toEqual([
      "Claude review: keep_recent (flagged)",
      "  Clips tool results; setup.sh does more than install.",
      "  ✗ drivers/keep_recent/setup.sh:4: Starts a background process.",
      "  ! drivers/keep_recent/driver.py: Tuned threshold.",
    ]);
  });

  it("says when the review didn't finish", async () => {
    const failed = {
      ...review,
      error: "Claude Code isn’t installed",
      cost_usd: undefined,
    };
    expect(formatClaudeMarkdown(failed)).toContain(
      "## ❌ Claude review: `keep_recent` didn’t finish\n\nClaude Code isn’t installed"
    );
  });
});
