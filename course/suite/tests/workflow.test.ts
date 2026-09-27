import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { listSuiteKeys } from "../src/keys.ts";
import { isRunnable, scanPackages } from "../src/packages.ts";
import { loadTargets } from "../src/targets.ts";

const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "suite.yml");

/** The `options:` list of one workflow_dispatch input. The file's shape is
 *  fixed enough that reading it line by line beats a YAML dependency. */
function inputOptions(yaml: string, input: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`      ${input}:`);
  if (start < 0) throw new Error(`no input ${input} in suite.yml`);
  const options: string[] = [];
  let inOptions = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,6}\S/.test(line)) break; // the next input, or the end of inputs
    if (line === "        options:") {
      inOptions = true;
    } else if (inOptions) {
      const item = /^ {10}- "?([^"]+)"?$/.exec(line);
      if (!item) break;
      options.push(item[1]!);
    }
  }
  return options;
}

describe("suite workflow", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");

  it("offers every suite file", async () => {
    expect(inputOptions(yaml, "suite")).toEqual([
      "<choose a suite>",
      ...listSuiteKeys().sort(),
    ]);
  });

  it("offers every runnable driver", async () => {
    const drivers = [...scanPackages().values()]
      .filter(isRunnable)
      .map((p) => p.name)
      .sort();
    expect(inputOptions(yaml, "driver")).toEqual([
      "<choose a driver>",
      ...drivers,
    ]);
  });

  it("offers every target", async () => {
    expect(inputOptions(yaml, "target")).toEqual(
      Object.keys(loadTargets()).sort()
    );
  });
});
