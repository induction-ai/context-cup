import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  cents,
  duration,
  elapsed,
  githubRunUrl,
  shortSha,
  targetSpec,
  tokens,
  truncate,
} from "../src/lib/format.ts";

describe("format", () => {
  it("prints money, tokens, and time compactly", async () => {
    expect(cents(null)).toBe("–");
    expect(cents(10.56)).toBe("10.6¢");
    expect(cents(123.4)).toBe("123¢");
    expect(tokens(950)).toBe("950");
    expect(tokens(45_807)).toBe("46k");
    expect(tokens(1_250_000)).toBe("1.3M");
    expect(duration(850)).toBe("850ms");
    expect(duration(12_000)).toBe("12s");
    expect(duration(271_000)).toBe("4m 31s");
    expect(duration(3_720_000)).toBe("1h 02m");
    const start = new Date("2026-09-22T10:00:00Z");
    expect(elapsed(start, new Date("2026-09-22T10:01:30Z"))).toBe("1m 30s");
    expect(elapsed(start, null, new Date("2026-09-22T10:00:05Z"))).toBe("5s");
  });

  it("describes targets, shas, and GitHub runs", async () => {
    expect(
      targetSpec({
        provider: "openai",
        model: "gpt-5.5",
        reasoning_effort: "medium",
      })
    ).toBe("openai/gpt-5.5@medium");
    expect(
      targetSpec({ provider: "gemini", model: "g", reasoning_effort: null })
    ).toBe("gemini/g");
    expect(shortSha("e5040af1234567")).toBe("e5040af");
    expect(shortSha(null)).toBe("–");
    expect(
      githubRunUrl({
        github_repository: null,
        github_run_id: null,
        github_run_attempt: null,
      })
    ).toBeNull();
    expect(
      githubRunUrl({
        github_repository: "o/r",
        github_run_id: "42",
        github_run_attempt: 1,
      })
    ).toBe("https://github.com/o/r/actions/runs/42");
    expect(
      githubRunUrl({
        github_repository: "o/r",
        github_run_id: "42",
        github_run_attempt: 3,
      })
    ).toBe("https://github.com/o/r/actions/runs/42/attempts/3");
    expect(truncate("x".repeat(200), 10)).toHaveLength(10);
    expect(truncate(null)).toBe("");
  });
});
