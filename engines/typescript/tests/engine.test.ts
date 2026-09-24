/** The TypeScript engine end to end: bundled as build.sh bundles a driver,
 *  run under node as run.sh runs it. */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bundleDriver } from "@context-cup/protocol/bundle.js";
import { beforeAll, expect, it } from "vitest";

const run = promisify(execFile);
const ENGINE = path.join(import.meta.dirname, "..");
const DRIVER = path.join(import.meta.dirname, "fixture_driver");

const payload = {
  model: "gpt-5.5",
  instructions: "be brief",
  input: [
    { role: "user", content: "hello" },
    {
      type: "function_call",
      call_id: "c1",
      name: "get_balance",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "c1", output: "y".repeat(50) },
  ],
};

let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cc-engine-ts-"));
  bundle = await bundleDriver({
    main: path.join(ENGINE, "src", "main.ts"),
    driverDir: DRIVER,
    outfile: path.join(dir, "bundle", "turn.mjs"),
  });
  writeFileSync(
    path.join(dir, "in.json"),
    JSON.stringify({
      trial_id: "t",
      turn_id: "001_aaaaaa",
      turn_index: 1,
      first: true,
      provider: {
        name: "openai",
        api_key: "cc-proxy",
        client: { base_url: "http://p/v1", api: "responses" },
      },
      target: { model: "gpt-5.5" },
      context_payload: payload,
      original_payload: payload,
      dirs: { turn: dir, state: path.join(dir, "state") },
    })
  );
});

function turn(env: Record<string, string> = {}) {
  return run(
    process.execPath,
    [
      "--enable-source-maps",
      bundle,
      ...["--driver", DRIVER],
      ...["--input", path.join(dir, "in.json")],
      ...["--output", path.join(dir, "out.json")],
    ],
    { env: { ...process.env, ...env } }
  );
}

it("runs a driver that edits through the view", async () => {
  await turn();
  const out = JSON.parse(readFileSync(path.join(dir, "out.json"), "utf8"));
  expect(out.response).toEqual({ id: "resp_1", output: [] });
  expect(out.state).toEqual({ seen: 3 });
  expect(JSON.stringify(out.context_payload)).toBe(
    JSON.stringify(payload).replace("y".repeat(50), "clipped")
  );
  expect(out.driver).toEqual({
    name: "fixture",
    engine: "typescript",
    version: "0.0.1",
  });
});

it("fails the turn with a trace pointing into driver.ts", async () => {
  const failed = await turn({ FIXTURE_FAIL: "1" }).catch((err) => err);
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("driver failed on purpose");
  expect(failed.stderr).toMatch(/fixture_driver\/driver\.ts:\d+/);
});
