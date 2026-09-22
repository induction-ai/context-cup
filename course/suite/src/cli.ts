import "@context-cup/shared/load_env.js";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  closeDb,
  getCurrentTransaction,
  getRawDatabase,
  withTransaction,
} from "@context-cup/db/connection.js";
import { suite as suiteTable } from "@context-cup/db/schema.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import { eq } from "drizzle-orm";
import pino from "pino";
import yargs from "yargs";
import {
  dropUnsupported,
  expandSuite,
  interleave,
  type Selection,
  type SuiteRun,
} from "./expand.ts";
import {
  assertTaskRunnable,
  buildHarborCommand,
  harborProvisioned,
  prepareHarbor,
  prepareJobDir,
  targetJson,
  type HarborEnv,
} from "./harbor.ts";
import { newId } from "./ids.ts";
import { ingestJob, insertJob, markJobStarted, parseJob } from "./ingest.ts";
import { listSuiteKeys, loadSuiteFile } from "./keys.ts";
import { driverProviders } from "./packages.ts";
import {
  resultsTable,
  summarizeCell,
  writeResults,
  type CellResult,
} from "./results.ts";
import { dockerJobCap, processQueue, type QueueEntry } from "./scheduler.ts";

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function list(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : [value]).map(String);
  return items.length > 0 ? items : undefined;
}

/** Concurrent trials inside one harbor job: as many as the cell allows. */
export function jobConcurrency(
  run: SuiteRun,
  suite_concurrency: number
): number {
  return Math.max(
    1,
    Math.min(
      run.count,
      suite_concurrency,
      run.task.concurrency ?? Infinity,
      run.target.concurrency ?? Infinity
    )
  );
}

async function main(): Promise<void> {
  const argv = yargs(process.argv.slice(2))
    .scriptName("bin/suite")
    .usage(
      `Usage: $0 <suite_key> [options]\n\nRun a suite: every task × driver × target in suites/<suite_key>.json.\nAvailable keys: ${listSuiteKeys().join(", ") || "(none)"}`
    )
    .command("$0 <suite_key>", "Run a suite", (y) =>
      y.positional("suite_key", { type: "string", demandOption: true })
    )
    .option("task", {
      type: "string",
      array: true,
      describe: "Only these tasks",
    })
    .option("driver", {
      type: "string",
      array: true,
      describe: "Only these drivers",
    })
    .option("target", {
      type: "string",
      array: true,
      describe: "Only these targets",
    })
    .option("harbor_env", {
      choices: ["docker", "daytona"] as const,
      default: "docker" as HarborEnv,
      describe: "Where harbor runs the task environment",
    })
    .option("log_dir", {
      type: "string",
      describe:
        "Parent directory for this suite's output (default .temp/suites)",
    })
    .option("verbose", {
      type: "boolean",
      default: false,
      describe: "Stream harbor output",
    })
    .option("dry_run", {
      type: "boolean",
      default: false,
      describe: "Print the jobs and their commands; run nothing, write nothing",
    })
    .alias("h", "help")
    .strict()
    .parseSync();

  const suite_key = argv.suite_key as string;
  const harbor_env = argv.harbor_env as HarborEnv;
  const { path: key_file, file } = loadSuiteFile(suite_key);
  const selection: Selection = {
    task: list(argv.task),
    driver: list(argv.driver),
    target: list(argv.target),
  };
  const expanded = dropUnsupported(expandSuite(file, selection), (name) =>
    driverProviders(name)
  );
  for (const s of expanded.skipped) {
    console.log(
      `skipping ${s.driver_name} × ${s.target_name}: the driver does not support provider ${s.provider}`
    );
  }
  const runs = interleave(expanded.runs);
  if (runs.length === 0) {
    throw new Error(
      expanded.skipped.length > 0
        ? "The selection expands to no jobs: every driver × target pair is unsupported."
        : "The selection expands to no jobs."
    );
  }

  const suite_id = newId("s");
  const suite_dir = path.resolve(
    argv.log_dir ?? path.join(REPO_ROOT, ".temp", "suites"),
    suite_id
  );
  const docker_jobs = harbor_env === "docker" ? dockerJobCap() : 0;

  const warnings: string[] = [];
  const entries: QueueEntry[] = runs.map((run) => {
    try {
      assertTaskRunnable(run);
    } catch (err) {
      if (!argv.dry_run) throw err;
      warnings.push(err instanceof Error ? err.message : String(err));
    }
    const job_id = newId("j");
    const concurrency = jobConcurrency(run, file.concurrency);
    const command = buildHarborCommand({
      run,
      job_id,
      suite_dir,
      harbor_env,
      concurrency,
    });
    return {
      job_id,
      run,
      env: command.env,
      concurrency_use: concurrency,
      uses_docker: harbor_env === "docker",
      command,
    };
  });

  const missing = new Set(entries.flatMap((e) => e.command.missing_keys));
  if (missing.size > 0) {
    console.warn(
      `warning: ${[...missing].join(", ")} not set; those trials will fail to authenticate`
    );
  }

  if (argv.dry_run) {
    console.log(
      `suite ${file.suite_name} (${key_file}): ${entries.length} job(s), harbor_env ${harbor_env}, docker cap ${docker_jobs || "none"}`
    );
    if (!harborProvisioned()) {
      console.log(
        "harbor is not provisioned yet; a real run clones the fork into .harbor/repo first"
      );
    }
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const e of entries) {
      console.log(
        `\n# ${e.job_id}: ${e.run.task_name} × ${e.run.driver_name} × ${e.run.target_name} (count ${e.run.count}, concurrency ${e.concurrency_use})`
      );
      console.log(`# env: ${e.command.env_names.join(" ")}`);
      console.log(e.command.shell);
    }
    return;
  }

  mkdirSync(path.join(suite_dir, "logs"), { recursive: true });
  const logger = pino(
    pino.destination(path.join(suite_dir, "logs", "suite.log"))
  );
  const report = (line: string) => {
    console.log(line);
    logger.info({ event: "report", line });
  };
  report(
    `suite ${suite_id}: ${file.suite_name}, ${entries.length} job(s) → ${path.relative(process.cwd(), suite_dir)}`
  );

  prepareHarbor(report);
  const started_at = new Date();
  await withTransaction(async () => {
    await getCurrentTransaction()
      .insert(suiteTable)
      .values({
        id: suite_id,
        name: file.suite_name,
        keyFile: path.relative(REPO_ROOT, key_file),
        gitSha: gitSha(),
        harborEnv: harbor_env,
        logDir: suite_dir,
        startedAt: started_at,
      });
    for (const e of entries) {
      await insertJob({
        job_id: e.job_id,
        suite_id,
        run: e.run,
        target: targetJson(e.run),
        concurrency: e.concurrency_use,
        command: e.command.shell,
        jobs_dir: e.command.jobs_dir,
      });
    }
  });
  logger.info({
    event: "suite_start",
    suite_id,
    key_file,
    harbor_env,
    jobs: entries.map((e) => ({
      job_id: e.job_id,
      task: e.run.task_name,
      driver: e.run.driver_name,
      target: e.run.target_name,
      command: e.command.shell,
    })),
  });

  const controller = new AbortController();
  const stop = () => {
    report("stopping: waiting for running jobs to be killed");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const cells: CellResult[] = [];
  const results = await processQueue(entries, {
    suite_concurrency: file.concurrency,
    docker_jobs,
    log_dir: suite_dir,
    verbose: argv.verbose,
    signal: controller.signal,
    report,
    on_started: async (entry) => {
      prepareJobDir(entry.command);
      logger.info({ event: "job_start", job_id: entry.job_id });
      await markJobStarted(entry.job_id, new Date());
    },
    on_finished: async (entry, result) => {
      // A trial that died early can leave partial artifacts; a parse failure
      // must still close the job out as failed rather than leave it running.
      let trials: ReturnType<typeof parseJob> = [];
      try {
        trials = parseJob(entry.command.jobs_dir, entry.command.job_name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          ...result,
          ok: false,
          error: [result.error, `ingest: ${message}`]
            .filter(Boolean)
            .join("; "),
        };
        logger.error({
          event: "job_parse_error",
          job_id: entry.job_id,
          message,
        });
      }
      logger.info({
        event: "job_finish",
        job_id: entry.job_id,
        result,
        trials,
      });
      await ingestJob(suite_id, entry.job_id, result, trials);
      const cell = summarizeCell(entry.run, trials);
      cells.push(cell);
      report(
        `[${entry.job_id}] ${trials.length} trial(s): reward ${cell.mean_reward?.toFixed(2) ?? "-"}, cost ${cell.mean_cost_cents?.toFixed(1) ?? "-"}¢`
      );
    },
  });

  const finished_at = new Date();
  await getRawDatabase()
    .update(suiteTable)
    .set({ finishedAt: finished_at })
    .where(eq(suiteTable.id, suite_id));
  cells.sort(
    (a, b) =>
      a.task_name.localeCompare(b.task_name) ||
      a.driver_name.localeCompare(b.driver_name) ||
      a.target_name.localeCompare(b.target_name)
  );
  writeResults(path.join(suite_dir, "results.json"), {
    suite_id,
    suite_name: file.suite_name,
    started_at: started_at.toISOString(),
    finished_at: finished_at.toISOString(),
    git_sha: gitSha(),
    harbor_env,
    jobs: results.map((r) => ({ job_id: r.job_id, ok: r.ok, error: r.error })),
    cells,
  });
  writeFileSync(
    path.join(suite_dir, "results.txt"),
    resultsTable(cells) + "\n"
  );
  console.log("\n" + resultsTable(cells));
  console.log(
    `\nresults: ${path.relative(process.cwd(), path.join(suite_dir, "results.json"))}`
  );
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(
      `${failed} of ${results.length} job(s) failed; see ${path.relative(process.cwd(), suite_dir)}/<job_id>.log`
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
