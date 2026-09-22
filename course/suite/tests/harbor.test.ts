import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "@context-cup/shared/test_helpers/index.js";
import {
  buildHarborCommand,
  envBuildTimeoutMultiplier,
  keyEnv,
  shellString,
  targetJson,
} from "../src/harbor.ts";
import { samplePackages, sampleRun, sampleSuite } from "./helpers.ts";

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
      "--agent-env",
      "OPENAI_API_KEY=$OPENAI_API_KEY",
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
    expect(command.env.PYTHONPATH).toMatch(/course\/runner\/src$/);
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
        target: file.targets["claude-sonnet-4-6"]!,
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
