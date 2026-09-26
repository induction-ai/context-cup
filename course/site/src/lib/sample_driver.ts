import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import type { Language } from "./highlight";

/** The home page's code samples: each lane's base driver, one tab per lane,
 *  read from drivers/ as the repo has it and cut down to its `run` (with its
 *  tunables shown as their defaults), so the page shows the real code. */
export const SAMPLE_DRIVERS = [
  { lane: "Python", path: "drivers/base_python/driver.py" },
  { lane: "TypeScript", path: "drivers/base_typescript/driver.ts" },
  { lane: "LiteLLM", path: "drivers/base_litellm/driver.py" },
  { lane: "AI SDK", path: "drivers/base_aisdk/driver.ts" },
  { lane: "Pydantic AI", path: "drivers/base_pydantic/driver.py" },
] as const;

export type SampleDriver = (typeof SAMPLE_DRIVERS)[number] & {
  language: Language;
  /** The driver's `run`, as `showDefaults` leaves it. */
  code: string;
};

/** A driver file's top-level `run`: Python's `def run(` through its
 *  indented body, or TypeScript's `export … function run(` through the
 *  closing brace at the start of a line. */
export function runFunction(source: string, language: Language): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    language === "python"
      ? line.startsWith("def run(")
      : /^export (async )?function run\(/.test(line)
  );
  if (start === -1) throw new Error("no top-level run");
  let end = start + 1;
  if (language === "python") {
    while (
      end < lines.length &&
      (lines[end] === "" || /^\s/.test(lines[end]!))
    ) {
      end++;
    }
  } else {
    while (end < lines.length && lines[end] !== "}") end++;
    end++;
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/** A sample's tunables as their defaults: a `ctx.config` lookup
 *  (`int(ctx.config.get("max_bytes", 100_000))`,
 *  `Number(ctx.config.max_bytes ?? 100_000)`) becomes the default it falls
 *  back to, and the comment explaining tunables goes. */
export function showDefaults(code: string): string {
  return code
    .replace(
      /^[ \t]*(#|\/\/) Tunables live in[^\n]*\n(?:[ \t]*(#|\/\/)[^\n]*\n)*?[ \t]*(#|\/\/)[^\n]*manifest edit\.\n/m,
      ""
    )
    .replace(/int\(ctx\.config\.get\("\w+", ([\d_]+)\)\)/g, "$1")
    .replace(/Number\(ctx\.config\.\w+ \?\? ([\d_]+)\)/g, "$1");
}

export async function loadSampleDrivers(): Promise<SampleDriver[]> {
  return Promise.all(
    SAMPLE_DRIVERS.map(async (d) => {
      const language: Language = d.path.endsWith(".ts")
        ? "typescript"
        : "python";
      const source = await readFile(path.join(REPO_ROOT, d.path), "utf8");
      return {
        ...d,
        language,
        code: showDefaults(runFunction(source, language)),
      };
    })
  );
}
