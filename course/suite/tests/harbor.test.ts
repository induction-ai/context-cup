import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "@context-cup/shared/test_helpers/index.js";
import {
  assertTaskRunnable,
  buildHarborCommand,
  envBuildTimeoutMultiplier,
  keyEnv,
  shellString,
  targetJson,
} from "../src/harbor.ts";
import { parseSuiteFile } from "../src/keys.ts";
import { MCP_REMOTE_VERSION } from "../src/mcp_auth.ts";
import {
  samplePackages,
  sampleRun,
  sampleSuite,
  sampleTargets,
} from "./helpers.ts";

const env = {
  HARBOR_DIR: "/opt/harbor",
  OPENAI_API_KEY: "sk-test",
};
const packages = samplePackages();

afterEach(() => vi.unstubAllEnvs());

function stub() {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

describe("buildHarborCommand", () => {
  it("builds a tau3 command", async () => {
    stub();
    const command = buildHarborCommand({
      run: sampleRun(),
      job_id: "j_test",
      suite_dir: "/tmp/suite",
      harbor_env: "docker",
      concurrency: 2,
      env,
      packages,
      host_arch: "arm64",
      cpus: 8,
    });
    const argv = command.argv.map((a) =>
      a.replace(/^\/.*context-cup\//, "<repo>/")
    );
    expect(argv).toEqual([
      "uv",
      "run",
      "--project",
      "/opt/harbor",
      "harbor",
      "run",
      "--dataset",
      "sierra-research/tau3-bench",
      "--include-task-name",
      "*tau3-banking_knowledge-task-001",
      "--agent",
      "context_cup_runner.tau3:Tau3Agent",
      "--model",
      "openai/gpt-5.5",
      "--agent-env",
      "CC_HOST_DRIVER_CHAIN=/ws/engines/python:/ws/drivers/base_passthrough",
      "--agent-env",
      'CC_TARGET_JSON={"provider":"openai","model":"gpt-5.5","reasoning_effort":"medium"}',
      "--agent-env",
      "CC_MAX_STEPS=200",
      "--n-attempts",
      "2",
      "--n-concurrent",
      "2",
      "--yes",
      "--override-cpus",
      "8",
      "--environment-build-timeout-multiplier",
      "4",
      "--agent-timeout-multiplier",
      "0.6667",
      "--extra-docker-compose",
      "<repo>/course/runner/tau3_docker_compose.yaml",
      "--jobs-dir",
      "/tmp/suite/j_test/harbor",
      "--job-name",
      "j_test",
    ]);
    expect(command.env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
    expect(command.env.PYTHONPATH).toMatch(
      /course\/runner\/src:.*course\/protocol\/src$/
    );
    expect(command.env.OPENAI_API_KEY).toBe("sk-test");
    expect(command.missing_keys).toEqual([]);
  });

  it("builds a toolathlon command on daytona", async () => {
    stub();
    const file = sampleSuite();
    const command = buildHarborCommand({
      run: sampleRun({
        task_name: "sales_accounting",
        task: file.tasks.sales_accounting!,
        runner: "toolathlon",
        target_name: "claude-sonnet-4-6",
        target: sampleTargets()["claude-sonnet-4-6"]!,
        count: 1,
      }),
      job_id: "j_tool",
      suite_dir: "/tmp/suite",
      harbor_env: "daytona",
      concurrency: 1,
      env,
      packages,
    });
    expect(command.argv.slice(5, 8)).toEqual([
      "run",
      "--path",
      "/opt/harbor/induction/tasks/toolathlon/sales-accounting",
    ]);
    expect(command.argv).toContain(
      "context_cup_runner.toolathlon:ToolathlonAgent"
    );
    expect(command.argv).toContain(
      'CC_TARGET_JSON={"provider":"anthropic","model":"claude-sonnet-4-6"}'
    );
    expect(command.argv).toContain("CC_MAX_STEPS=150");
    expect(command.argv.join(" ")).toContain(
      "--env daytona --environment-build-timeout-multiplier 2 --max-retries 1"
    );
    // The trial's budget (40m) plus 30m overhead plus a 10m margin.
    expect(command.argv).toContain("auto_stop_interval_mins=80");
    expect(command.argv).toContain(
      'labels={"context-cup-suite":"suite","context-cup-job":"j_tool"}'
    );
    expect(command.argv).not.toContain("--override-cpus");
    expect(command.argv).not.toContain("--extra-docker-compose");
    expect(command.missing_keys).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

describe("helpers", () => {
  it("target json carries provider, model, and reasoning effort only", async () => {
    expect(
      targetJson(
        sampleRun({
          target: { provider: "openai", model: "m", reasoning_effort: "low" },
        })
      )
    ).toEqual({ provider: "openai", model: "m", reasoning_effort: "low" });
    expect(
      targetJson(sampleRun({ target: { provider: "gemini", model: "m" } }))
    ).toEqual({ provider: "gemini", model: "m" });
  });
  it("key env aliases gemini both ways", async () => {
    expect(keyEnv({ GOOGLE_API_KEY: "g" })).toEqual({
      GOOGLE_API_KEY: "g",
      GEMINI_API_KEY: "g",
    });
    expect(keyEnv({})).toEqual({});
  });
  it("build timeout multiplier", async () => {
    expect(envBuildTimeoutMultiplier("arm64", {})).toBe(4);
    expect(envBuildTimeoutMultiplier("x64", {})).toBe(1);
    expect(
      envBuildTimeoutMultiplier("x64", { SUITE_ENV_BUILD_TIMEOUT_MULT: "3" })
    ).toBe(3);
  });
  it("shell quoting", async () => {
    expect(shellString(["a", "b c", "it's"])).toBe("a 'b c' 'it'\\''s'");
    expect(shellString(["--agent-env", "OPENAI_API_KEY=$OPENAI_API_KEY"])).toBe(
      '--agent-env OPENAI_API_KEY="$OPENAI_API_KEY"'
    );
  });
});

describe("agent-kind drivers", () => {
  it("run harbor's own agent through the proxy, with no driver chain", async () => {
    stub();
    const command = buildHarborCommand({
      run: sampleRun({ driver_name: "base_codex" }),
      job_id: "j_codex",
      suite_dir: "/tmp/suite",
      harbor_env: "docker",
      concurrency: 1,
      packages,
    });
    const agentIndex = command.argv.indexOf("--agent");
    expect(command.argv[agentIndex + 1]).toBe(
      "context_cup_runner.codex:CodexAgent"
    );
    expect(
      command.argv.some((a) => a.startsWith("CC_HOST_DRIVER_CHAIN="))
    ).toBe(false);
    expect(command.argv.some((a) => a.startsWith("CC_PROXY_URL="))).toBe(false);
    expect(command.argv.some((a) => /_API_KEY=/.test(a))).toBe(false);
    expect(command.env.PYTHONPATH).toContain("course/runner/src");
  });

  it("run a script agent's agent.sh through the benchmark's script agent, with its chain", async () => {
    const withAgent = new Map(packages);
    withAgent.set("@context-cup-drivers/base_agent", {
      name: "@context-cup-drivers/base_agent",
      dir: "/ws/drivers/base_agent",
      kind: "agent",
    });
    const command = buildHarborCommand({
      run: sampleRun({ driver_name: "base_agent" }),
      job_id: "j_agent",
      suite_dir: "/tmp/suite",
      harbor_env: "docker",
      concurrency: 1,
      packages: withAgent,
    });
    const agentIndex = command.argv.indexOf("--agent");
    expect(command.argv[agentIndex + 1]).toBe(
      "context_cup_runner.agent:Tau3ScriptAgent"
    );
    expect(command.argv).toContain(
      "CC_HOST_DRIVER_CHAIN=/ws/drivers/base_agent"
    );
    expect(command.argv.some((a) => /_API_KEY=/.test(a))).toBe(false);
  });

  it("hand the runner the proxy bundle and the save-bodies switch", async () => {
    const command = buildHarborCommand({
      run: sampleRun({ driver_name: "base_codex" }),
      job_id: "j_codex",
      suite_dir: "/tmp/suite",
      harbor_env: "docker",
      concurrency: 1,
      packages,
      env: { ...env, CC_SAVE_BODIES: "1" },
      proxy_bundle: "/repo/course/proxy/dist/proxy.cjs",
    });
    // The bundle path is for harbor's process, which uploads it; the switch
    // reaches the agent, which starts the trial's proxy with it.
    expect(command.env.CC_PROXY_BUNDLE).toBe(
      "/repo/course/proxy/dist/proxy.cjs"
    );
    expect(command.argv).toContain("CC_SAVE_BODIES=1");
  });
});

describe("assertTaskRunnable", () => {
  const toolathlon = (task_name: string) =>
    sampleRun({
      task_name,
      task: parseSuiteFile({ tasks: { [task_name]: { runner: "toolathlon" } } })
        .tasks[task_name]!,
      runner: "toolathlon",
    });

  function mcpDir(loggedIn: boolean): string {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-mcp-"));
    if (loggedIn) {
      const state = path.join(dir, `mcp-remote-${MCP_REMOTE_VERSION}`);
      mkdirSync(state);
      writeFileSync(path.join(state, "abc_tokens.json"), "{}");
    }
    return dir;
  }

  it("runs a notion task once secrets/mcp holds a login", async () => {
    expect(() =>
      assertTaskRunnable(toolathlon("notion_hr"), mcpDir(true))
    ).not.toThrow();
  });

  it("refuses a notion task without a login, saying how to log in", async () => {
    expect(() =>
      assertTaskRunnable(toolathlon("notion_hr"), mcpDir(false))
    ).toThrow(/notion_hr needs notion MCP OAuth state in .*npx -y mcp-remote/s);
  });

  it("lets other tasks run without one", async () => {
    const none = mcpDir(false);
    expect(() =>
      assertTaskRunnable(toolathlon("sales_accounting"), none)
    ).not.toThrow();
    expect(() => assertTaskRunnable(sampleRun(), none)).not.toThrow();
  });
});
