/** build.sh: the host-side step of a driver chain, run root first before
 *  any trial. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { buildChain } from "../src/build.ts";
import type { CupPackage } from "../src/packages.ts";

function pkg(root: string, name: string, build?: string): CupPackage {
  const dir = path.join(root, name);
  mkdirSync(dir);
  if (build) writeFileSync(path.join(dir, "build.sh"), build);
  return { name: `@t/${name}`, dir, kind: "driver" };
}

describe("buildChain", () => {
  it("runs each build.sh root first with the chain's host paths", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cc-build-"));
    const log = path.join(root, "log");
    const record = `echo "$(basename "$PWD") $CC_SELF_DIR $CC_DRIVER_DIR $CC_CHAIN" >> ${log}\n`;
    const chain = [
      pkg(root, "engine", record),
      pkg(root, "middle"),
      pkg(root, "leaf", record),
    ];
    expect(await buildChain(chain)).toEqual(["@t/engine", "@t/leaf"]);
    const dirs = chain.map((p) => p.dir);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      `engine ${dirs[0]} ${dirs[2]} ${dirs.join(":")}`,
      `leaf ${dirs[2]} ${dirs[2]} ${dirs.join(":")}`,
    ]);
  });

  it("fails with the script's output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cc-build-"));
    const chain = [pkg(root, "engine", "echo no bundler here >&2; exit 3\n")];
    await expect(buildChain(chain)).rejects.toThrow(
      /@t\/engine: build.sh failed \(exit 3\)\nno bundler here/
    );
  });
});
