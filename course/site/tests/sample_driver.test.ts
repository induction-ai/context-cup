import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  loadSampleDrivers,
  runFunction,
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
  it("reads every lane's base driver down to its run", async () => {
    const drivers = await loadSampleDrivers();
    expect(drivers.map((d) => d.lane)).toEqual([
      "Python",
      "TypeScript",
      "LiteLLM",
      "AI SDK",
      "Pydantic AI",
    ]);
    for (const d of drivers) {
      expect(d.code).toMatch(
        d.language === "python"
          ? /^def run\(ctx/
          : /^export async function run\(ctx/
      );
      expect(d.code).not.toMatch(/ctx\.config|Tunables/);
    }
  });
});
