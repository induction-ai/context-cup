/** The TypeScript manifest reader's own failures;
 *  tests/test_protocol_contract.py checks it reads every manifest as the
 *  Python one does. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readManifest } from "../src/manifest.ts";

describe("readManifest", () => {
  it("fails naming a file that does not parse", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cup-manifest-"));
    try {
      writeFileSync(path.join(dir, "pyproject.toml"), "[project\nname = 'x'\n");
      expect(() => readManifest(dir)).toThrow(/pyproject\.toml: /);
      writeFileSync(path.join(dir, "package.json"), "{ nope");
      expect(() => readManifest(dir)).toThrow(/package\.json: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
