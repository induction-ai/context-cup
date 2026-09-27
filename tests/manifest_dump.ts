/** Reads a JSON list of package directories on stdin and prints `{ dir:
 *  manifest | null }` from the TypeScript reader, for
 *  test_protocol_contract.py. */
import { readFileSync } from "node:fs";
import { readManifest } from "../course/protocol/src/manifest.ts";

const dirs = JSON.parse(readFileSync(0, "utf8")) as string[];
const out = Object.fromEntries(
  dirs.map((dir) => [dir, readManifest(dir) ?? null])
);
process.stdout.write(JSON.stringify(out));
