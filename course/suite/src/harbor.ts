import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { arch, availableParallelism } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import type { SuiteRun } from "./expand.ts";
import type { Provider } from "./keys.ts";
import { driverChainDirs, type CupPackage } from "./packages.ts";
import {
  tau3TaskGlob,
  TOOLATHLON_NOTION_TASKS,
  toolathlonTaskDir,
} from "./tasks.ts";

export type HarborEnv = "docker" | "daytona";

// ---------------------------------------------------------------------------
// Resolving the `harbor` CLI. By default a run uses the induction-ai fork,
// which carries the toolathlon task bundles, checked out under `.harbor/repo`
// and run from its own uv venv. HARBOR_DIR=global uses the `harbor` on PATH;
// any other HARBOR_DIR is a local checkout to run from.
// ---------------------------------------------------------------------------

export const HARBOR_REPO_URL = "https://github.com/induction-ai/harbor";
export const HARBOR_ROOT = path.join(REPO_ROOT, ".harbor");
export const DEFAULT_HARBOR_DIR = path.join(HARBOR_ROOT, "repo");
export const SECRETS_DIR = path.join(REPO_ROOT, "secrets");
export const TOOLATHLON_AUTH_ZIP = path.join(
  SECRETS_DIR,
  "toolathlon_auth_configs.zip"
);
export const MCP_AUTH_DIR = path.join(SECRETS_DIR, "mcp");

export type Report = (message: string) => void;

export function harborDir(): string {
  const configured = process.env.HARBOR_DIR?.trim();
  if (!configured || configured.toLowerCase() === "global") {
    return DEFAULT_HARBOR_DIR;
  }
  return path.resolve(configured);
}

function usesGlobalHarbor(): boolean {
  return (process.env.HARBOR_DIR ?? "").trim().toLowerCase() === "global";
}

/** The argv prefix that invokes harbor. */
export function harborArgv(): string[] {
  if (usesGlobalHarbor()) return ["harbor"];
  return ["uv", "run", "--project", harborDir(), "harbor"];
}

export function toolathlonTasksDir(): string {
  return path.resolve(
    process.env.TOOLATHLON_TASKS_DIR ??
      path.join(harborDir(), "induction", "tasks", "toolathlon")
  );
}

function run(command: string, cwd: string): void {
  try {
    execSync(command, { cwd, stdio: "pipe" });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    const output = [stdout, stderr].filter(Boolean).map(String).join("\n");
    throw new Error(`${command} failed:\n${output}`.trim(), { cause: err });
  }
}

/** Whether harbor is ready to run without provisioning. */
export function harborProvisioned(): boolean {
  if (usesGlobalHarbor()) return true;
  return existsSync(path.join(harborDir(), ".git"));
}

/** Clone or update the fork and sync its venv. Idempotent; once per process. */
let provisioned = false;
export function prepareHarbor(report: Report): void {
  if (provisioned) return;
  provisioned = true;
  if (usesGlobalHarbor()) {
    report("harbor: using the harbor on PATH (HARBOR_DIR=global)");
    return;
  }
  const dir = harborDir();
  if (existsSync(path.join(dir, ".git"))) {
    if (!process.env.HARBOR_DIR) {
      report(`harbor: updating ${path.relative(REPO_ROOT, dir)}`);
      run("git pull --ff-only", dir);
    }
  } else {
    report(
      `harbor: cloning ${HARBOR_REPO_URL} into ${path.relative(REPO_ROOT, dir)}`
    );
    mkdirSync(path.dirname(dir), { recursive: true });
    run(`git clone ${HARBOR_REPO_URL} ${JSON.stringify(dir)}`, REPO_ROOT);
  }
  run("uv sync --extra daytona", dir);
  report(`harbor: fork at ${headSha(dir)}`);
  syncToolathlonAuthConfig(report);
}

function headSha(dir: string): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Copy the real toolathlon credentials zip (kept under secrets/, never in
 *  git) into every task's build context. Without it the self-contained tasks
 *  still run on placeholder configs. */
export function syncToolathlonAuthConfig(report: Report): void {
  if (!existsSync(TOOLATHLON_AUTH_ZIP)) return;
  const tasksDir = toolathlonTasksDir();
  if (!existsSync(tasksDir)) return;
  let count = 0;
  for (const task of readdirSync(tasksDir)) {
    const envDir = path.join(tasksDir, task, "environment");
    if (!existsSync(envDir)) continue;
    copyFileSync(TOOLATHLON_AUTH_ZIP, path.join(envDir, "configs.zip"));
    count++;
  }
  report(
    `harbor: applied toolathlon auth configs to ${count} task build contexts`
  );
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

export const RUNNER_SRC = path.join(REPO_ROOT, "course", "runner", "src");
export const TAU3_COMPOSE_OVERRIDE = path.join(
  REPO_ROOT,
  "course",
  "runner",
  "tau3_docker_compose.yaml"
);

const RUNNER_AGENTS = {
  tau3: "context_cup_runner.tau3:Tau3Agent",
  toolathlon: "context_cup_runner.toolathlon:ToolathlonAgent",
} as const;

const PROVIDER_KEY_ENV: Record<Provider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

export const KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DAYTONA_API_KEY",
] as const;

/** Provider keys forwarded from the shell env, with the gemini alias filled
 *  in either direction. */
export function keyEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEY_ENV_NAMES) {
    const value = env[name];
    if (value) out[name] = value;
  }
  const gemini = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (gemini) {
    out.GEMINI_API_KEY = gemini;
    out.GOOGLE_API_KEY = gemini;
  }
  return out;
}

/** The `target` object the runner passes to every driver turn. */
export function targetJson(run: SuiteRun): {
  provider: Provider;
  model: string;
  reasoning_effort?: string;
} {
  const { provider, model, reasoning_effort } = run.target;
  return {
    provider,
    model,
    ...(reasoning_effort ? { reasoning_effort } : {}),
  };
}

export type HarborCommand = {
  /** argv, starting with the harbor invocation (uv run … harbor run …).
   *  Secret values are `$NAME` references, expanded by the shell at launch. */
  argv: string[];
  /** The argv as one shell command line: what runs, what is logged. */
  shell: string;
  /** Process env beyond the inherited shell env. Values may be secrets:
   *  never log this; log {@link HarborCommand.env_names}. */
  env: Record<string, string>;
  env_names: string[];
  /** Parent dir of harbor's job directory (`--jobs-dir`). */
  jobs_dir: string;
  /** `--job-name`; the job's trials land under `<jobs_dir>/<job_name>/`. */
  job_name: string;
  /** Names of provider keys the run needs but the env lacks. */
  missing_keys: string[];
};

export type CommandInputs = {
  run: SuiteRun;
  job_id: string;
  suite_dir: string;
  harbor_env: HarborEnv;
  /** Concurrent trials within the job (`--n-concurrent`). */
  concurrency: number;
  env?: NodeJS.ProcessEnv;
  host_arch?: string;
  cpus?: number;
  /** Driver and engine packages; defaults to the workspace scan. */
  packages?: ReadonlyMap<string, CupPackage>;
};

/** Stretch harbor's environment-build timeout on arm64, where the amd64
 *  task images build under emulation. SUITE_ENV_BUILD_TIMEOUT_MULT overrides. */
export function envBuildTimeoutMultiplier(
  hostArch: string = arch(),
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.SUITE_ENV_BUILD_TIMEOUT_MULT);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return hostArch === "arm64" ? 4 : 1;
}

function taskArgs(run: SuiteRun): string[] {
  if (run.task.runner === "tau3") {
    return [
      "--dataset",
      "sierra-research/tau3-bench",
      "--include-task-name",
      tau3TaskGlob(run.task.tau3.customer),
    ];
  }
  const dir = toolathlonTaskDir(run.task.toolathlon.task ?? run.task_name);
  return ["--path", path.join(toolathlonTasksDir(), dir)];
}

/** Fail fast on a notion task without OAuth state rather than letting its
 *  preprocess hang until harbor's timeout. */
export function assertTaskRunnable(run: SuiteRun): void {
  if (run.task.runner !== "toolathlon") return;
  const dir = toolathlonTaskDir(run.task.toolathlon.task ?? run.task_name);
  if (TOOLATHLON_NOTION_TASKS.has(dir) && !existsSync(MCP_AUTH_DIR)) {
    throw new Error(
      `${run.task_name} needs notion MCP OAuth state under ${path.relative(REPO_ROOT, MCP_AUTH_DIR)}; see README`
    );
  }
}

/** Build one `harbor run` invocation for a matrix cell. Pure apart from
 *  reading the driver manifest; nothing is created on disk. */
export function buildHarborCommand(inputs: CommandInputs): HarborCommand {
  const { run, job_id, harbor_env } = inputs;
  const env = inputs.env ?? process.env;
  const chain = driverChainDirs(run.driver_name, inputs.packages);
  const jobs_dir = path.join(inputs.suite_dir, job_id, "harbor");
  const target = targetJson(run);
  const keys = keyEnv(env);

  // Secrets never appear in argv, the log, or the database: each key is a
  // `$NAME` shell reference that expands from the process env at launch.
  const agentEnv: Record<string, string> = {
    // Host paths. harbor layers --agent-env over every exec the agent runs,
    // so the runner keeps a separate CC_DRIVER_CHAIN for the container copies.
    CC_HOST_DRIVER_CHAIN: chain.join(":"),
    CC_TARGET_JSON: JSON.stringify(target),
    CC_MAX_STEPS: String(run.task.runner === "tau3" ? 200 : 150),
  };
  for (const name of Object.keys(keys)) agentEnv[name] = `$${name}`;

  const cpus = Math.min(inputs.cpus ?? availableParallelism() ?? 1, 8);
  const argv = [
    ...harborArgv(),
    "run",
    ...taskArgs(run),
    "--agent",
    RUNNER_AGENTS[run.task.runner],
    "--model",
    `${run.target.provider}/${run.target.model}`,
    ...Object.entries(agentEnv).flatMap(([k, v]) => [
      "--agent-env",
      `${k}=${v}`,
    ]),
    "--n-attempts",
    String(run.count),
    "--n-concurrent",
    String(inputs.concurrency),
    "--yes",
  ];
  if (harbor_env === "docker") {
    argv.push(
      "--override-cpus",
      String(cpus),
      "--environment-build-timeout-multiplier",
      String(envBuildTimeoutMultiplier(inputs.host_arch, env))
    );
    if (run.task.runner === "toolathlon" && existsSync(MCP_AUTH_DIR)) {
      argv.push(
        "--mounts",
        JSON.stringify([
          {
            type: "bind",
            source: MCP_AUTH_DIR,
            target: "/workspace/configs/.mcp-auth",
          },
        ])
      );
    }
  } else {
    argv.push(
      "--env",
      "daytona",
      "--environment-build-timeout-multiplier",
      "2",
      "--max-retries",
      "1"
    );
  }
  // Tasks pin a 60 minute agent timeout; scale it to the suite's budget so a
  // hung trial fails inside harbor before the outer wall clock kills the job.
  argv.push(
    "--agent-timeout-multiplier",
    (run.timeout_minutes / 60).toFixed(4)
  );
  if (run.task.runner === "tau3") {
    argv.push("--extra-docker-compose", TAU3_COMPOSE_OVERRIDE);
  }
  argv.push("--jobs-dir", jobs_dir, "--job-name", job_id);

  const processEnv: Record<string, string> = {
    PYTHONUNBUFFERED: "1",
    LITELLM_LOG: env.LITELLM_LOG ?? "ERROR",
    PYTHONPATH: env.PYTHONPATH
      ? `${RUNNER_SRC}${path.delimiter}${env.PYTHONPATH}`
      : RUNNER_SRC,
    // The tau3 user simulator and verifier run on the real OpenAI API.
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    ...keys,
  };

  const required = PROVIDER_KEY_ENV[run.target.provider];
  const missing_keys = required.some((k) => keys[k]) ? [] : required;

  return {
    argv,
    shell: shellString(argv),
    env: processEnv,
    env_names: Object.keys(processEnv),
    jobs_dir,
    job_name: job_id,
    missing_keys,
  };
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const ENV_REFERENCE = /^([A-Z][A-Z0-9_]*=)\$([A-Z][A-Z0-9_]*)$/;

/** Quote argv as a shell command line. A `NAME=$VAR` argument keeps its
 *  reference unquoted so the shell expands it at launch. */
export function shellString(argv: readonly string[]): string {
  return argv
    .map((a) => {
      const ref = ENV_REFERENCE.exec(a);
      if (ref) return `${ref[1]}"$${ref[2]}"`;
      if (SHELL_SAFE.test(a)) return a;
      return `'${a.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}

/** Start from a clean job dir: harbor treats --jobs-dir/--job-name as a
 *  resumable job and refuses a leftover with a different config. */
export function prepareJobDir(command: HarborCommand): void {
  mkdirSync(command.jobs_dir, { recursive: true });
  rmSync(path.join(command.jobs_dir, command.job_name), {
    recursive: true,
    force: true,
  });
}
