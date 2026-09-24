/** Ingest keeps what it can: a trial it can't read is that trial's error,
 *  not the job's, and the files a killed trial leaves behind still parse. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  clipError,
  parseJob,
  parseTrial,
  readCallLog,
  withMissingTrials,
} from "../src/ingest.ts";

const CALL = {
  trial_id: "t1",
  turn_id: "001_aaaaaa",
  sequence: 1,
  purpose: "turn",
  provider: "openai",
  host: "api.openai.com",
  model: "gpt-5.5",
  wire: "responses",
  usage: { input: 10, output: 2 },
  status: 200,
  started_at: "2026-09-22T10:00:00.000Z",
};

function trial_dir(
  jobDir: string,
  name: string,
  result: Record<string, unknown>
): string {
  const dir = path.join(jobDir, name);
  mkdirSync(path.join(dir, "agent"), { recursive: true });
  writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ trial_name: name, ...result })
  );
  return dir;
}

describe("ingest robustness", () => {
  it("drops a partial last line a killed proxy left, but not a corrupt one mid-file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-ingest-"));
    const partial = path.join(dir, "partial.jsonl");
    writeFileSync(partial, `${JSON.stringify(CALL)}\n{"sequence": 2, "tu`);
    expect(readCallLog(partial).map((c) => c.sequence)).toEqual([1]);
    const corrupt = path.join(dir, "corrupt.jsonl");
    writeFileSync(corrupt, `{"sequence": 2, "tu\n${JSON.stringify(CALL)}\n`);
    expect(() => readCallLog(corrupt)).toThrow(/corrupt\.jsonl:1/);
  });

  it("takes the only named reward, and the whole trial's span when the agent's is missing", async () => {
    const jobDir = mkdtempSync(path.join(tmpdir(), "cc-ingest-"));
    const t = parseTrial(
      trial_dir(jobDir, "t1", {
        verifier_result: { rewards: { accuracy: 0.5 } },
        started_at: "2026-09-01T00:00:00Z",
        finished_at: "2026-09-01T00:01:30Z",
        agent_execution: { started_at: "2026-09-01T00:00:10Z" },
      })
    );
    expect(t.reward).toBe(0.5);
    expect(t.duration_ms).toBe(90_000);
  });

  it("leaves a negative or unparseable span unknown", async () => {
    const jobDir = mkdtempSync(path.join(tmpdir(), "cc-ingest-"));
    const t = parseTrial(
      trial_dir(jobDir, "t1", {
        agent_execution: {
          started_at: "2026-09-01T00:01:00Z",
          finished_at: "2026-09-01T00:00:00Z",
        },
        started_at: "not a date",
        finished_at: "2026-09-01T00:00:00Z",
      })
    );
    expect(t.duration_ms).toBeNull();
  });

  it("keeps both ends of an over-long error: harbor puts the reason last", async () => {
    const clipped = clipError(
      `Command failed: ${"x".repeat(5000)} stderr: boom`
    );
    expect(clipped.length).toBeLessThanOrEqual(2001);
    expect(clipped.startsWith("Command failed:")).toBe(true);
    expect(clipped.endsWith("stderr: boom")).toBe(true);
    expect(clipError("short")).toBe("short");
  });

  it("records a trial it can't read as that trial's error and keeps the rest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cc-ingest-"));
    const jobDir = path.join(root, "j_x");
    trial_dir(jobDir, "good", { verifier_result: { rewards: { reward: 1 } } });
    const bad = trial_dir(jobDir, "bad", {});
    writeFileSync(path.join(bad, "result.json"), "{ not json");
    const trials = parseJob(root, "j_x");
    expect(
      trials.map((t) => [t.trial_name, t.reward, t.error !== null])
    ).toEqual([
      ["bad", null, true],
      ["good", 1, false],
    ]);
    expect(trials[0]!.error).toMatch(/^ingest: /);
  });

  it("gives every owed trial a row", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cc-ingest-"));
    const jobDir = path.join(root, "j_x");
    trial_dir(jobDir, "good", { verifier_result: { rewards: { reward: 1 } } });
    const padded = withMissingTrials(parseJob(root, "j_x"), 3, jobDir);
    expect(padded.map((t) => t.trial_name)).toEqual([
      "good",
      "missing_1",
      "missing_2",
    ]);
    expect(padded[1]!.error).toBe(
      "harbor recorded 1 of 3 trial(s); this one left nothing"
    );
    expect(withMissingTrials(padded, 2, jobDir)).toHaveLength(3);
  });
});
