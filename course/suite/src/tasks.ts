import taskNames from "./task_names.json" with { type: "json" };

/** Toolathlon tasks by alias (the suite-file key) → harbor task directory. */
export const TOOLATHLON_TASKS: Record<string, string> = taskNames.toolathlon;

/** Notion-backed toolathlon tasks: their preprocess needs OAuth state under
 *  `secrets/mcp`, so they fail fast at launch when it is absent. */
export const TOOLATHLON_NOTION_TASKS = new Set([
  "experiments-recordings",
  "k8s-pr-preview-testing",
  "notion-find-job",
  "notion-hr",
  "notion-movies",
  "notion-personal-website",
  "oil-price",
  "quantitative-financial-analysis",
  "task-tracker",
]);

/** A toolathlon alias: the directory name with runs of non-alphanumerics
 *  collapsed to one underscore. */
export function toolathlonAlias(task: string): string {
  return task.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The harbor task directory for a suite-file task key or a directory name. */
export function toolathlonTaskDir(task: string): string {
  const dir = TOOLATHLON_TASKS[toolathlonAlias(task)];
  if (dir) return dir;
  throw new Error(
    `Unknown toolathlon task: ${task}. Known aliases are the keys of course/suite/src/task_names.json.`
  );
}

// τ³-bench's banking_knowledge domain: task ids run 001–102 but five are
// missing upstream.
const BANKING_GAPS = new Set([9, 11, 13, 30, 42]);

/** Every banking task alias, `banking_001` … `banking_102` minus the gaps. */
export const TAU3_BANKING_TASKS: string[] = Array.from(
  { length: 102 },
  (_, i) => i + 1
)
  .filter((id) => !BANKING_GAPS.has(id))
  .map((id) => `banking_${String(id).padStart(3, "0")}`);

/** The `--include-task-name` glob for a tau3 customer alias such as
 *  `banking_047`. Only the banking domain is wired up. */
export function tau3TaskGlob(customer: string): string {
  const match = /^banking_(\d{3})$/.exec(customer);
  if (!match || !TAU3_BANKING_TASKS.includes(customer)) {
    throw new Error(
      `Unknown tau3 customer: ${customer}. Expected banking_001 … banking_102 (minus upstream gaps).`
    );
  }
  return `*tau3-banking_knowledge-task-${match[1]}`;
}
