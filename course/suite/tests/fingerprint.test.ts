import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { driverFingerprint, fingerprintDirs } from "../src/fingerprint.ts";
import { scanPackages } from "../src/packages.ts";

describe("fingerprintDirs", () => {
  let root: string;
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  const fp = () =>
    fingerprintDirs(
      [path.join(root, "engines/e"), path.join(root, "drivers/d")],
      root
    );

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cup-fp-"));
    write(".gitignore", "node_modules\n__pycache__/\ndrivers/*/bundle/\n");
    write("engines/e/run.sh", "echo engine\n");
    write("drivers/d/driver.py", "print('d')\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is stable and versioned", async () => {
    expect(fp()).toBe(fp());
    expect(fp()).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("ignores what .gitignore ignores", async () => {
    const before = fp();
    write("drivers/d/bundle/turn.mjs", "built");
    write("drivers/d/__pycache__/driver.pyc", "cache");
    write("engines/e/node_modules/x/index.js", "dep");
    expect(fp()).toBe(before);
  });

  it("changes with the driver or anything it extends", async () => {
    const before = fp();
    write("drivers/d/driver.py", "print('e')\n");
    const edited = fp();
    expect(edited).not.toBe(before);
    write("engines/e/run.sh", "echo engine 2\n");
    expect(fp()).not.toBe(edited);
  });

  it("changes when a file is renamed or added", async () => {
    const before = fp();
    write("drivers/d/README.md", "hi");
    expect(fp()).not.toBe(before);
  });

  it("ignores files outside the chain", async () => {
    const before = fp();
    write("course/runner/loop.py", "anything");
    write("drivers/other/driver.py", "anything");
    expect(fp()).toBe(before);
  });
});

describe("driverFingerprint", () => {
  it("reads the real workspace", async () => {
    const packages = scanPackages();
    const python = driverFingerprint("base_python", packages);
    expect(python).toBe(driverFingerprint("base_python", packages));
    expect(python).not.toBe(driverFingerprint("base_litellm", packages));
  });
});
