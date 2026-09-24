/** The scheduler against real processes: how a job that has to be stopped
 *  is stopped. The fake launcher in scheduler.test.ts can't show this. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { processQueue, type QueueEntry } from "../src/scheduler.ts";
import { sampleRun } from "./helpers.ts";

function entry(job_id: string, shell: string, timeout_minutes: number) {
  return {
    job_id,
    run: sampleRun({ count: 1, timeout_minutes }),
    env: {},
    concurrency_use: 1,
    uses_docker: false,
    command: {
      argv: [],
      shell,
      env: {},
      env_names: [],
      jobs_dir: "/tmp/x",
      job_name: job_id,
      missing_keys: [],
    },
  } satisfies QueueEntry;
}

/** jobTimeoutMs adds 30 minutes of slack per wave; this leaves `seconds`. */
const timeoutIn = (seconds: number) => -30 + seconds / 60;

/** A node child that records each SIGTERM, writes a heartbeat, and either
 *  ignores SIGTERM or exits on it. */
function child(dir: string, ignoreTerm: boolean, closeOutput = false): string {
  const script = path.join(dir, "child.cjs");
  writeFileSync(
    script,
    `
    const fs = require('node:fs');
    const dir = ${JSON.stringify(dir)};
    process.on('SIGTERM', () => {
      fs.appendFileSync(dir + '/terms', 'term\\n');
      if (${!ignoreTerm}) setTimeout(() => process.exit(0), 100);
    });
    fs.writeFileSync(dir + '/pid', String(process.pid));
    if (${closeOutput}) { fs.closeSync(1); fs.closeSync(2); }
    setInterval(() => fs.writeFileSync(dir + '/heartbeat', String(Date.now())), 50);
    setTimeout(() => process.exit(0), 20_000);
    `
  );
  return script;
}

function killLeftover(dir: string) {
  try {
    process.kill(
      Number(readFileSync(path.join(dir, "pid"), "utf8")),
      "SIGKILL"
    );
  } catch {
    // Already gone, or never started.
  }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await delay(50);
}

describe.skipIf(process.platform === "win32")(
  "processQueue with real processes",
  () => {
    it.each([
      { output: "open", closeOutput: false },
      { output: "closed", closeOutput: true },
    ])(
      "kills a timed-out job whose child ignores SIGTERM (output $output), then runs the next",
      async ({ closeOutput }) => {
        const dir = mkdtempSync(path.join(tmpdir(), "cc-sched-"));
        const script = child(dir, true, closeOutput);
        const killed: string[] = [];
        try {
          const started = Date.now();
          const results = await processQueue(
            [
              // Piped, so the child is not the process the scheduler started:
              // only the group kill reaches it.
              entry(
                "a",
                `"${process.execPath}" "${script}" | cat`,
                timeoutIn(1)
              ),
              entry("b", "true", 10),
            ],
            {
              suite_concurrency: 1,
              docker_jobs: 0,
              log_dir: dir,
              kill_grace_ms: 500,
              report: () => {},
              on_killed: async (e, reason) => {
                killed.push(`${e.job_id}:${reason}`);
              },
            }
          );
          expect(results.map((r) => [r.job_id, r.ok])).toEqual([
            ["a", false],
            ["b", true],
          ]);
          expect(results[0]!.error).toContain("timed out");
          expect(killed).toEqual(["a:timed_out"]);
          expect(Date.now() - started).toBeLessThan(10_000);
          const last = readFileSync(path.join(dir, "heartbeat"), "utf8");
          await delay(250);
          expect(readFileSync(path.join(dir, "heartbeat"), "utf8")).toBe(last);
        } finally {
          killLeftover(dir);
        }
      },
      20_000
    );

    it("sends a cancelled command exactly one SIGTERM and lets it finish its teardown", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "cc-sched-"));
      const script = child(dir, false);
      // Stands in for uv: it forwards SIGTERM to the child it runs (harbor), so
      // a TERM to the whole group would reach the child twice.
      const forwarder = path.join(dir, "forwarder.cjs");
      writeFileSync(
        forwarder,
        `
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, [${JSON.stringify(script)}], { stdio: 'inherit' });
      process.on('SIGTERM', () => c.kill('SIGTERM'));
      c.on('exit', (code) => process.exit(code ?? 1));
      `
      );
      const controller = new AbortController();
      const killed: string[] = [];
      try {
        const running = processQueue(
          [entry("a", `"${process.execPath}" "${forwarder}"`, 10)],
          {
            suite_concurrency: 1,
            docker_jobs: 0,
            log_dir: dir,
            kill_grace_ms: 2_000,
            signal: controller.signal,
            report: () => {},
            on_killed: async (e, reason) => {
              killed.push(`${e.job_id}:${reason}`);
            },
          }
        );
        await until(() => {
          try {
            readFileSync(path.join(dir, "heartbeat"));
            return true;
          } catch {
            return false;
          }
        });
        controller.abort();
        const [result] = await running;
        expect(result!.error).toBe("cancelled");
        expect(killed).toEqual(["a:cancelled"]);
        expect(readFileSync(path.join(dir, "terms"), "utf8")).toBe("term\n");
      } finally {
        killLeftover(dir);
      }
    }, 20_000);

    it("stops admitting jobs once halted, and says why", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "cc-sched-"));
      const lines: string[] = [];
      let reason: string | null = null;
      const results = await processQueue(
        [entry("a", "true", 10), entry("b", "true", 10)],
        {
          suite_concurrency: 1,
          docker_jobs: 0,
          log_dir: dir,
          report: (l) => lines.push(l),
          on_finished: async () => {
            reason = "results can't be stored: db down";
          },
          halted: () => reason,
        }
      );
      expect(results.map((r) => r.job_id)).toEqual(["a"]);
      expect(lines).toContain(
        "stopping the suite: results can't be stored: db down; 1 job(s) not run"
      );
    });
  }
);
