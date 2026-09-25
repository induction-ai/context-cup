import "@context-cup/shared/load_env.js";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  closeDb,
  getCurrentTransaction,
  getRawDatabase,
  withTransaction,
} from "@context-cup/db/connection.js";
import { suite as suiteTable } from "@context-cup/db/schema.js";
import { buildProxyBundle } from "@context-cup/proxy/bundle.js";
import { REFERENCE_TARGET } from "@context-cup/shared/reference_target.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import { eq } from "drizzle-orm";
import pino from "pino";
import yargs from "yargs";
import { buildDriver } from "./build.ts";
import {
  daytonaClient,
  deleteSandboxes,
  JOB_LABEL,
  listSandboxes,
  SUITE_LABEL,
} from "./daytona.ts";
import {
  expandSuite,
  interleave,
  type Selection,
  type SuiteRun,
} from "./expand.ts";
import {
  assertTaskRunnable,
  buildHarborCommand,
  harborProvisioned,
  needsNotionAuth,
  prepareHarbor,
  prepareJobDir,
  targetJson,
  toolathlonTasksDir,
  type HarborEnv,
} from "./harbor.ts";
import { newId } from "./ids.ts";
import {
  ingestJob,
  insertJob,
  markJobStarted,
  parseJob,
  withMissingTrials,
  type ParsedTrial,
} from "./ingest.ts";
import { listSuiteKeys, loadSuiteFile } from "./keys.ts";
import { resolveLaunch, type Asker, type Choice } from "./launch.ts";
import { prepareMcpAuthForDaytona } from "./mcp_auth.ts";
import { workspacePackages } from "./packages.ts";
import {
  resultsHeader,
  resultsTable,
  suiteTotals,
  summarizeCell,
  writeResults,
  type CellResult,
} from "./results.ts";
import {
  RETRY_ERRORS_MAX_FAILURE_RATE,
  shortfallRuns,
  shouldRetryErrors,
  totalCount,
} from "./retry.ts";
import {
  dockerJobCap,
  processQueue,
  type QueueEntry,
  type SchedulerOptions,
} from "./scheduler.ts";
import { scoredTrials } from "./scoring.ts";
import { describeTarget, loadTargets } from "./targets.ts";

/** Where the results site is served; bin/suite prints a link into it. */
export function suiteUrl(suite_id: string, env = process.env): string {
  const base = (env.SITE_URL || "http://localhost:3300").replace(/\/+$/, "");
  return `${base}/suites/${suite_id}`;
}

/** The GitHub Actions run this suite belongs to, when there is one. */
export function githubRun(env: Record<string, string | undefined>): {
  github_run_id: string | null;
  github_run_attempt: number | null;
  github_repository: string | null;
} {
  if (!env.GITHUB_RUN_ID) {
    return {
      github_run_id: null,
      github_run_attempt: null,
      github_repository: null,
    };
  }
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  return {
    github_run_id: env.GITHUB_RUN_ID,
    github_run_attempt:
      Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    github_repository: env.GITHUB_REPOSITORY ?? null,
  };
}

function git_sha(): string | null {
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

/** Concurrent trials inside one harbor job: as many as the task allows. */
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

/** Numbered choices on the terminal; the answer is a number or a name. */
function terminalAsker(): Asker | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return async (question: string, choices: Choice[]) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      console.log(`\n${question}:`);
      const width = Math.max(...choices.map((c) => c.name.length));
      choices.forEach((c, i) => {
        const detail = c.detail ? `  ${c.detail}` : "";
        console.log(
          `  ${String(i + 1).padStart(2)}. ${c.name.padEnd(width)}${detail}`
        );
      });
      for (;;) {
        const answer = (
          await rl.question(`${question} [1-${choices.length}]: `)
        ).trim();
        const index = /^\d+$/.test(answer)
          ? Number(answer) - 1
          : choices.findIndex((c) => c.name === answer);
        if (index >= 0 && index < choices.length) return index;
        console.log(`  pick 1-${choices.length} or a name from the list`);
      }
    } finally {
      rl.close();
    }
  };
}

async function main(): Promise<void> {
  const argv = yargs(process.argv.slice(2))
    .scriptName("bin/suite")
    .usage(
      `Usage: $0 <suite_key> --driver <name> [--target <name>] [options]\n\nRun the tasks of suites/<suite_key>.json with one driver against one target.\nThe target defaults to ${REFERENCE_TARGET} when the driver supports it.\nOmit --driver, or --target for a driver that can't run the default, on a terminal to pick from a list.\nAvailable keys: ${listSuiteKeys().join(", ") || "(none)"}`
    )
    .command("$0 <suite_key>", "Run a suite", (y) =>
      y.positional("suite_key", { type: "string", demandOption: true })
    )
    .option("driver", {
      type: "string",
      describe: "The driver package under drivers/, by short name",
    })
    .option("target", {
      type: "string",
      describe: `A target name from targets.json (default ${REFERENCE_TARGET}, when the driver supports it)`,
    })
    .option("count", {
      type: "number",
      describe:
        "Trials per task (harbor --n-attempts); default the suite file’s count, else 1",
    })
    .option("task", {
      type: "string",
      array: true,
      describe: "Only these tasks (includes explicit_only ones)",
    })
    .option("harbor_env", {
      choices: ["docker", "daytona"] as const,
      default: "docker" as HarborEnv,
      describe: "Where harbor runs the task environment",
    })
    .option("retry_errors", {
      type: "number",
      default: 0,
      describe:
        "After the suite finishes, rerun the trials that did not finish, up to this many more passes. Skipped when more than half the trials failed. Every attempt is kept",
    })
    .option("log_dir", {
      type: "string",
      describe:
        "Parent directory for this suite’s output (default .temp/suites)",
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
  const count = argv.count ?? file.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("--count must be a positive integer");
  }
  const retry_errors = argv.retry_errors;
  if (!Number.isInteger(retry_errors) || retry_errors < 0) {
    throw new Error("--retry_errors must be a whole number, 0 or more");
  }
  const launch = await resolveLaunch({
    driver: argv.driver,
    target: argv.target,
    targets: loadTargets(),
    packages: workspacePackages(),
    ask: terminalAsker(),
  });
  const spec = { ...launch, count };
  const selection: Selection = { task: list(argv.task) };
  const runs = interleave(expandSuite(file, spec, selection));
  if (runs.length === 0) throw new Error("The selection expands to no jobs.");

  const suite_id = newId("s");
  const suite_dir = path.resolve(
    argv.log_dir ?? path.join(REPO_ROOT, ".temp", "suites"),
    suite_id
  );
  const docker_jobs = harbor_env === "docker" ? dockerJobCap() : 0;

  // The proxy runs inside every trial container (the runner uploads this
  // bundle), holds the keys there, and writes the trial's own calls.jsonl.
  const proxy_bundle = argv.dry_run ? undefined : await buildProxyBundle();
  // Each build.sh in the driver's chain, on the host (a TypeScript driver is
  // bundled here); the runner uploads what they leave in the package.
  if (!argv.dry_run) await buildDriver(spec.driver_name);

  const warnings: string[] = [];
  const makeEntry = (run: SuiteRun): QueueEntry => {
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
      proxy_bundle,
    });
    return {
      job_id,
      run,
      env: command.env,
      concurrency_use: concurrency,
      uses_docker: harbor_env === "docker",
      command,
    };
  };
  const entries = runs.map(makeEntry);

  const missing = new Set(entries.flatMap((e) => e.command.missing_keys));
  if (missing.size > 0) {
    console.warn(
      `warning: ${[...missing].join(", ")} not set; those trials will fail to authenticate`
    );
  }

  if (argv.dry_run) {
    console.log(
      `suite ${suite_key} (${key_file}): ${entries.length} job(s), driver ${spec.driver_name}, target ${spec.target_name} (${describeTarget(spec.target)}), count ${count}, harbor_env ${harbor_env}, docker cap ${docker_jobs || "none"}`
    );
    if (!harborProvisioned()) {
      console.log(
        "harbor is not provisioned yet; a real run clones the fork into .harbor/repo first"
      );
    }
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const e of entries) {
      console.log(
        `\n# ${e.job_id}: ${e.run.task_name} (count ${e.run.count}, concurrency ${e.concurrency_use})`
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
    `suite ${suite_id}: ${suite_key}, ${entries.length} job(s), driver ${spec.driver_name}, target ${spec.target_name} (${describeTarget(spec.target)}) → ${path.relative(process.cwd(), suite_dir)}`
  );

  const harbor_sha = prepareHarbor(report);
  report(`results page: ${suiteUrl(suite_id)}`);
  const started_at = new Date();
  await withTransaction(async () => {
    await getCurrentTransaction()
      .insert(suiteTable)
      .values({
        id: suite_id,
        name: suite_key,
        key_file: path.relative(REPO_ROOT, key_file),
        driver_name: spec.driver_name,
        target_name: spec.target_name,
        provider: spec.target.provider,
        model: spec.target.model,
        reasoning_effort: spec.target.reasoning_effort ?? null,
        count,
        git_sha: git_sha(),
        harbor_sha: harbor_sha,
        ...githubRun(process.env),
        harbor_env: harbor_env,
        log_dir: suite_dir,
        started_at: started_at,
      });
    await insertJobs(entries, 0);
  });
  logger.info({
    event: "suite_start",
    suite_id,
    key_file,
    harbor_env,
    driver: spec.driver_name,
    target: spec.target_name,
    count,
    jobs: entries.map((e) => ({
      job_id: e.job_id,
      task: e.run.task_name,
      command: e.command.shell,
    })),
  });

  // The first SIGINT or SIGTERM stops the run: running jobs are killed, their
  // sandboxes deleted, and what finished is still ingested and reported.
  // Later signals change nothing (the default handler would exit at once and
  // orphan harbor's process groups); a hard deadline covers a stuck cleanup.
  const controller = new AbortController();
  let stopped_by: number | null = null;
  const stop = (code: number) => {
    if (stopped_by !== null) return;
    stopped_by = code;
    report("stopping: waiting for running jobs to be killed");
    controller.abort();
    // Ten seconds for termination, sixty for sandbox cleanup, then reporting.
    setTimeout(() => process.exit(code), 80_000).unref();
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));

  /** Set by the first failure to store results. From then on no job starts:
   *  every later one would be lost the same way, burning sandbox time on
   *  results nobody can see. */
  let store_failure: string | null = null;
  const storing = async <T>(what: string, write: () => Promise<T>) => {
    try {
      return await write();
    } catch (err) {
      store_failure ??= `results can’t be stored (${what}: ${err instanceof Error ? err.message : String(err)})`;
      throw err;
    }
  };

  // Every job's trials by task: a retry pass adds a job to the same task.
  const trialsByTask = new Map<string, ParsedTrial[]>();
  const queueOptions: SchedulerOptions = {
    suite_concurrency: file.concurrency,
    docker_jobs,
    log_dir: suite_dir,
    verbose: argv.verbose,
    signal: controller.signal,
    report,
    on_started: async (entry) => {
      // Daytona cannot mount secrets/mcp, so a notion task gets a fresh
      // token baked into its image's configs instead.
      if (harbor_env === "daytona" && needsNotionAuth(entry.run)) {
        await prepareMcpAuthForDaytona(toolathlonTasksDir(), report);
      }
      prepareJobDir(entry.command);
      logger.info({
        event: "job_start",
        job_id: entry.job_id,
        task_name: entry.run.task_name,
        runner: entry.run.runner,
        driver: entry.run.driver_name,
        target: entry.run.target_name,
        provider: entry.run.target.provider,
        model: entry.run.target.model,
        count: entry.run.count,
        concurrency_use: entry.concurrency_use,
        command: entry.command.shell,
      });
      await storing("job start", () =>
        markJobStarted(entry.job_id, new Date())
      );
    },
    // A killed harbor never deletes its own sandboxes; free the quota now
    // rather than at the end of the suite.
    on_killed: async (entry) => {
      if (harbor_env !== "daytona") return;
      const client = daytonaClient();
      const sandboxes = await listSandboxes(client, {
        labels: { [SUITE_LABEL]: suite_id, [JOB_LABEL]: entry.job_id },
      });
      if (sandboxes.length === 0) return;
      const { deleted, failed } = await deleteSandboxes(
        client,
        sandboxes.map((s) => s.id)
      );
      report(`[${entry.job_id}] deleted ${deleted.length} Daytona sandbox(es)`);
      if (failed.size > 0) {
        throw new Error(
          `${failed.size} Daytona sandbox(es) not deleted: ${[...failed].map(([id, why]) => `${id}: ${why}`).join("; ")}`
        );
      }
    },
    halted: () => store_failure,
    on_finished: async (entry, result) => {
      // A trial that died early can leave partial artifacts; a parse failure
      // must still close the job out as failed rather than leave it running.
      let trials: ReturnType<typeof parseJob> = [];
      let parse_error: string | undefined;
      try {
        trials = parseJob(entry.command.jobs_dir, entry.command.job_name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        parse_error = message;
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
      // Every trial the job owed gets a row: one harbor left nothing for is
      // an errored placeholder, and a clean exit that recorded fewer than it
      // owed is a failed job.
      const recorded = trials.length;
      trials = withMissingTrials(
        trials,
        entry.run.count,
        path.join(entry.command.jobs_dir, entry.command.job_name)
      );
      let short: string | undefined;
      if (result.ok && recorded < entry.run.count) {
        short = `harbor recorded ${recorded} of ${entry.run.count} trial(s)`;
        result = { ...result, ok: false, error: short };
      }
      logger.info({
        event: "job_finish",
        job_id: entry.job_id,
        result,
        trials,
      });
      // Before storing them: trials read from disk belong in results.json
      // even when the database has gone away.
      trialsByTask.set(entry.run.task_name, [
        ...(trialsByTask.get(entry.run.task_name) ?? []),
        ...trials,
      ]);
      await storing("ingest", () =>
        ingestJob(suite_id, entry.job_id, result, trials)
      );
      const cell = summarizeCell(entry.run, trials);
      if (parse_error) {
        // The row now says failed; the scheduler must too (console, exit
        // code, results.json), so the failure keeps bubbling.
        throw new Error(`ingest: ${parse_error.split("\n")[0]}`);
      }
      if (short) throw new Error(short);
      const errored = trials.filter((t) => t.error);
      report(
        `[${entry.job_id}] ${trials.length} trial(s): reward ${cell.mean_reward?.toFixed(2) ?? "-"}, cost ${cell.mean_cost_cents?.toFixed(1) ?? "-"}¢` +
          (errored.length > 0
            ? `, ${errored.length} errored: ${errored[0]!.error!.split("\n")[0]}`
            : "")
      );
    },
  };
  const results = await processQueue(entries, queueOptions);

  const expected_trials = totalCount(runs);
  const doneByTask = () =>
    new Map(
      [...trialsByTask].map(([task, trials]) => [
        task,
        scoredTrials(trials).length,
      ])
    );
  for (let pass = 1; pass <= retry_errors; pass++) {
    // Once results can't be stored, a retry would be lost the same way.
    if (controller.signal.aborted || store_failure !== null) break;
    const owed = shortfallRuns(runs, doneByTask());
    const shortfall = totalCount(owed);
    if (shortfall === 0) break;
    if (!shouldRetryErrors(shortfall, expected_trials)) {
      report(
        `\nretry_errors: ${shortfall} of ${expected_trials} trial(s) did not finish, over ${RETRY_ERRORS_MAX_FAILURE_RATE * 100}%; not retrying`
      );
      break;
    }
    report(
      `\nretry_errors: pass ${pass}/${retry_errors}, retrying ${shortfall} of ${expected_trials} trial(s) that did not finish`
    );
    const retries = interleave(owed).map(makeEntry);
    try {
      await storing("retry jobs", () =>
        withTransaction(() => insertJobs(retries, pass))
      );
    } catch {
      break; // store_failure says why, after the results files are written
    }
    results.push(...(await processQueue(retries, queueOptions)));
  }
  const unfinished = totalCount(shortfallRuns(runs, doneByTask()));

  const finished_at = new Date();
  const cells: CellResult[] = runs
    .map((run) => summarizeCell(run, trialsByTask.get(run.task_name) ?? []))
    .sort((a, b) => a.task_name.localeCompare(b.task_name));
  const results_out = {
    suite_id,
    suite_name: suite_key,
    driver_name: spec.driver_name,
    target_name: spec.target_name,
    target: spec.target,
    count,
    started_at: started_at.toISOString(),
    finished_at: finished_at.toISOString(),
    git_sha: git_sha(),
    harbor_sha,
    harbor_env,
    retry_errors,
    expected_trials,
    jobs: results.map((r) => ({ job_id: r.job_id, ok: r.ok, error: r.error })),
    cells,
    ...suiteTotals(cells),
  };
  writeResults(path.join(suite_dir, "results.json"), results_out);
  const table = `${resultsHeader(results_out)}\n${resultsTable(cells)}`;
  writeFileSync(path.join(suite_dir, "results.txt"), table + "\n");
  // After the files, so a database that has gone away can't cost the run its
  // results on disk.
  try {
    await getRawDatabase()
      .update(suiteTable)
      .set({ finished_at: finished_at })
      .where(eq(suiteTable.id, suite_id));
  } catch (err) {
    console.error(
      `could not mark the suite finished: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
  console.log("\n" + table);
  console.log(
    `\nresults: ${path.relative(process.cwd(), path.join(suite_dir, "results.json"))}\n         ${suiteUrl(suite_id)}`
  );
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(
      `${failed} of ${results.length} job(s) failed; see ${path.relative(process.cwd(), suite_dir)}/<job_id>.log`
    );
  }
  const errored = cells.reduce((n, c) => n + c.errors, 0);
  if (errored > 0) {
    console.log(
      `${errored} trial(s) errored; see ${suiteUrl(suite_id)} for each error`
    );
  }
  // A trial that never finished is unscored work: the run did not measure
  // what it meant to. One a retry made up is not.
  if (unfinished > 0) {
    console.log(
      `${unfinished} of ${expected_trials} trial(s) did not finish` +
        (retry_errors > 0 ? ` after ${retry_errors} retry pass(es)` : "")
    );
    process.exitCode = 1;
  } else if (failed > 0 && retry_errors === 0) {
    process.exitCode = 1;
  }
  if (store_failure !== null) {
    console.log(`stopped early: ${store_failure}`);
    process.exitCode = 1;
  }
  // Stopped by a signal: the shell's convention (130 for SIGINT, 143 for
  // SIGTERM) says so.
  if (stopped_by !== null) process.exitCode = stopped_by;

  async function insertJobs(
    jobs: readonly QueueEntry[],
    pass: number
  ): Promise<void> {
    for (const e of jobs) {
      await insertJob({
        job_id: e.job_id,
        suite_id,
        run: e.run,
        target: targetJson(e.run),
        concurrency: e.concurrency_use,
        command: e.command.shell,
        jobs_dir: e.command.jobs_dir,
        pass,
      });
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
