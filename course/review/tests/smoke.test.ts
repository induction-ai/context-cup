import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  formatSmokeMarkdown,
  formatSmokeText,
  SMOKE_MARKER,
} from "../src/smoke.ts";

describe("smoke formatting", () => {
  const results = [
    {
      suite: "smoke_tau",
      ok: true,
      log_dir: ".temp/review/smoke_tau/s1",
      results: "table\n",
    },
    {
      suite: "smoke_toolathlon",
      ok: false,
      log_dir: ".temp/review/smoke_toolathlon/s2",
    },
  ];

  it("fails the comment when any suite fails, and shows each table", async () => {
    const markdown = formatSmokeMarkdown("keep_recent", results);
    expect(markdown.split("\n")[0]).toBe(SMOKE_MARKER);
    expect(markdown).toContain("## ❌ Smoke run: `keep_recent`");
    expect(markdown).toContain("### `smoke_tau`: ✅ passed\n\n```\ntable\n```");
    expect(markdown).toContain("### `smoke_toolathlon`: ❌ failed");
    expect(
      formatSmokeMarkdown("keep_recent", [results[0]!]).split("\n")[1]
    ).toBe("## ✅ Smoke run: `keep_recent`");
  });

  it("points a terminal at a failed suite's logs", async () => {
    expect(formatSmokeText("keep_recent", results)).toBe(
      [
        "Smoke run: keep_recent",
        "  ✓ smoke_tau",
        "  ✗ smoke_toolathlon: see .temp/review/smoke_toolathlon/s2",
      ].join("\n")
    );
  });
});
