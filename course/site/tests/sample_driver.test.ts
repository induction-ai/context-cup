import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  GAP,
  loadSampleDrivers,
  runFunction,
  SAMPLE_DRIVERS,
  SAMPLE_EXCERPTS,
  showDefaults,
} from "../src/lib/sample_driver.ts";

describe("runFunction", () => {
  it("cuts a Python def run through its indented body", () => {
    const source =
      "import x\n\n\ndef run(ctx):\n    a = 1\n\n    return a\n\n\ndef other():\n    pass\n";
    expect(runFunction(source, "python")).toBe(
      "def run(ctx):\n    a = 1\n\n    return a"
    );
  });

  it("cuts a TypeScript run through its closing brace", () => {
    const source =
      "const a = 1;\n\nexport async function run(ctx) {\n  if (a) {\n    return 1;\n  }\n}\n\nexport const b = 2;\n";
    expect(runFunction(source, "typescript")).toBe(
      "export async function run(ctx) {\n  if (a) {\n    return 1;\n  }\n}"
    );
  });

  it("fails loudly without a top-level run", () => {
    expect(() => runFunction("def walk(ctx):\n    pass\n", "python")).toThrow(
      "no top-level run"
    );
  });
});

describe("showDefaults", () => {
  it("shows a tunable as its default and drops the comment on tunables", () => {
    const python = [
      "def run(ctx):",
      "    # Tunables live in package.json's contextCup.config, so a variant is a",
      "    # manifest edit.",
      '    max_bytes = int(ctx.config.get("max_bytes", 100_000))',
      "    return max_bytes",
    ].join("\n");
    expect(showDefaults(python)).toBe(
      "def run(ctx):\n    max_bytes = 100_000\n    return max_bytes"
    );
    const typescript = [
      "  // Tunables live in package.json's contextCup.config, so a variant is a",
      "  // manifest edit.",
      "  const maxBytes = Number(ctx.config.max_bytes ?? 100_000);",
    ].join("\n");
    expect(showDefaults(typescript)).toBe("  const maxBytes = 100_000;");
  });
});

describe("loadSampleDrivers", () => {
  it("shows one tab per lane", async () => {
    const drivers = await loadSampleDrivers();
    expect(drivers.map((d) => d.lane)).toEqual([
      "Python",
      "TypeScript",
      "LiteLLM",
      "AI SDK · TS",
      "AI SDK · Py",
      "Pydantic AI",
      "LangChain",
      "LlamaIndex",
    ]);
  });

  it("cuts a base driver down to its run, tunables as their defaults", async () => {
    const drivers = (await loadSampleDrivers()).filter((d) =>
      SAMPLE_DRIVERS.some((s) => s.path === d.path)
    );
    expect(drivers).toHaveLength(SAMPLE_DRIVERS.length);
    for (const d of drivers) {
      expect(d.code).toMatch(
        d.language === "python"
          ? /^def run\(ctx/
          : /^export async function run\(ctx/
      );
      expect(d.code).not.toMatch(/ctx\.config|Tunables/);
    }
  });

  it("shows an excerpted driver as lines its file still has", async () => {
    const drivers = (await loadSampleDrivers()).filter((d) =>
      SAMPLE_EXCERPTS.some((s) => s.path === d.path)
    );
    expect(drivers).toHaveLength(SAMPLE_EXCERPTS.length);
    for (const d of drivers) {
      const source = await readFile(path.join(REPO_ROOT, d.path), "utf8");
      const lines = source.split("\n").map((line) => line.trim());
      for (const line of d.code.split("\n")) {
        if (line === "" || line === GAP) continue;
        expect(lines, `${d.path}: ${line}`).toContain(line.trim());
      }
    }
  });
});
