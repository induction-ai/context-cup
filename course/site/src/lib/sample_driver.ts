import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import type { Language } from "./highlight";

/** The home page's code samples, one tab per lane: each base driver, read
 *  from drivers/ as the repo has it and cut down to its `run` (with its
 *  tunables shown as their defaults), so the page shows the real code. */
export const SAMPLE_DRIVERS = [
  { lane: "Python", path: "drivers/base_python/driver.py" },
  { lane: "TypeScript", path: "drivers/base_typescript/driver.ts" },
  { lane: "LiteLLM", path: "drivers/base_litellm/driver.py" },
  { lane: "AI SDK · TS", path: "drivers/base_aisdk/driver.ts" },
  { lane: "AI SDK · Py", path: "drivers/base_aisdk_python/driver.py" },
  { lane: "Pydantic AI", path: "drivers/base_pydantic/driver.py" },
] as const;

/** A gap between a sample's excerpts. */
export const GAP = "...";

/** Lanes whose base driver has no `run` to cut out: the lines where the
 *  same strategy sits inside the framework, copied here since they are
 *  scattered through the file. The test checks every line is still there. */
export const SAMPLE_EXCERPTS: { lane: string; path: string; code: string }[] = [
  {
    lane: "LangChain",
    path: "drivers/base_langchain/agent.py",
    code: `@wrap_tool_call
async def clip_tool_result(
    request: ToolCallRequest, handler: ToolHandler
) -> ToolMessage | Command[Any]:
    result = await handler(request)
    if isinstance(result, ToolMessage):
        text = tool_text(result)
        result.content = clip(text, max_bytes)
    return result

${GAP}

agent = create_agent(
    model(target),
    tools,
    system_prompt=env.get("CC_SYSTEM_PROMPT") or SYSTEM,
    middleware=[
        one_at_a_time(asyncio.Lock()),
        clip_tool_results(max_bytes),
        retry_empty_replies,
        ModelCallLimitMiddleware(run_limit=max_steps, exit_behavior="end"),
    ],
)
state = await agent.ainvoke(
    {"messages": [HumanMessage(instruction)]},
    config={"recursion_limit": NODES_PER_STEP * max_steps + 10},
)`,
  },
  {
    lane: "LlamaIndex",
    path: "drivers/base_llamaindex/agent.py",
    code: `async def callback(result: CallToolResult) -> str:
    text = result_text(result)
    return clip(text, max_bytes)

${GAP}

FunctionTool.from_defaults(
    async_fn=one_at_a_time(tool.async_fn, lock),
    tool_metadata=replace(tool.metadata, name=name),
    async_callback=clipped(name, max_bytes),
)

${GAP}

agent = FunctionAgent(
    tools=list(tools),
    llm=model(target),
    system_prompt=env.get("CC_SYSTEM_PROMPT") or SYSTEM,
    streaming=False,
)
handler = agent.run(**run, max_iterations=remaining)
async for event in handler.stream_events():
    if isinstance(event, ToolCallResult):
        result["env_tool_calls"] += 1
    elif isinstance(event, AgentOutput) and not blank(event.response):
        result["turns"] += 1
await handler`,
  },
];

export type SampleDriver = {
  lane: string;
  path: string;
  language: Language;
  /** The driver's `run`, as `showDefaults` leaves it, or its
   *  excerpts. */
  code: string;
};

/** A driver file's top-level `run`: Python's `def run(` through its
 *  indented body, or TypeScript's `export … function run(` through the
 *  closing brace at the start of a line. */
export function runFunction(source: string, language: Language): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    language === "python"
      ? line.startsWith("def run(")
      : /^export (async )?function run\(/.test(line)
  );
  if (start === -1) throw new Error("no top-level run");
  let end = start + 1;
  if (language === "python") {
    while (
      end < lines.length &&
      (lines[end] === "" || /^\s/.test(lines[end]!))
    ) {
      end++;
    }
  } else {
    while (end < lines.length && lines[end] !== "}") end++;
    end++;
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/** A sample's tunables as their defaults: a `ctx.config` lookup
 *  (`int(ctx.config.get("max_bytes", 100_000))`,
 *  `Number(ctx.config.max_bytes ?? 100_000)`) becomes the default it falls
 *  back to, and the comment explaining tunables goes. */
export function showDefaults(code: string): string {
  return code
    .replace(
      /^[ \t]*(#|\/\/) Tunables live in[^\n]*\n(?:[ \t]*(#|\/\/)[^\n]*\n)*?[ \t]*(#|\/\/)[^\n]*manifest edit\.\n/m,
      ""
    )
    .replace(/int\(ctx\.config\.get\("\w+", ([\d_]+)\)\)/g, "$1")
    .replace(/Number\(ctx\.config\.\w+ \?\? ([\d_]+)\)/g, "$1");
}

export async function loadSampleDrivers(): Promise<SampleDriver[]> {
  const cut = await Promise.all(
    SAMPLE_DRIVERS.map(async (d): Promise<SampleDriver> => {
      const language: Language = d.path.endsWith(".ts")
        ? "typescript"
        : "python";
      const source = await readFile(path.join(REPO_ROOT, d.path), "utf8");
      return {
        ...d,
        language,
        code: showDefaults(runFunction(source, language)),
      };
    })
  );
  const excerpts = SAMPLE_EXCERPTS.map(
    (d): SampleDriver => ({ ...d, language: "python" })
  );
  return [...cut, ...excerpts];
}
