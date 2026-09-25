/** --append: top an existing suite up to its count. The suite keeps its id and
 *  row; each task runs only the trials it still owes (its count minus its done
 *  trials so far), as new jobs under the suite, numbered on from its last
 *  pass. Like a --retry_errors pass, every earlier attempt is kept and a
 *  task's score is the mean over the done trials of all its jobs. */
import { getCurrentTransaction } from "@context-cup/db/connection.js";
import { job, suite, trial } from "@context-cup/db/schema.js";
import { eq, max } from "drizzle-orm";
import type { ParsedTrial } from "./ingest.ts";
import type { Target } from "./targets.ts";

export type StoredSuite = typeof suite.$inferSelect;

/** An existing suite and what it has run so far. */
export type AppendBase = {
  suite: StoredSuite;
  /** The tasks it has jobs for, in name order. */
  task_names: string[];
  /** The pass the append's first jobs get: one past the suite's last. */
  next_pass: number;
  /** Every trial it has stored, by task; enough of each for scoring and the
   *  results table. */
  trials_by_task: Map<string, ParsedTrial[]>;
};

export async function loadAppendBase(suite_id: string): Promise<AppendBase> {
  const db = getCurrentTransaction();
  const [row] = await db.select().from(suite).where(eq(suite.id, suite_id));
  if (!row) throw new Error(`--append: no suite ${suite_id}`);
  const tasks = await db
    .selectDistinct({ task_name: job.task_name })
    .from(job)
    .where(eq(job.suite_id, suite_id));
  const [last] = await db
    .select({ pass: max(job.pass) })
    .from(job)
    .where(eq(job.suite_id, suite_id));
  const rows = await db
    .select()
    .from(trial)
    .where(eq(trial.suite_id, suite_id));
  const trials_by_task = new Map<string, ParsedTrial[]>();
  for (const t of rows) {
    const stored: ParsedTrial = {
      trial_name: t.trial_name,
      trial_dir: t.trial_dir,
      reward: t.reward,
      score_reason: t.score_reason,
      error: t.error,
      stop_reason: t.stop_reason,
      turns: t.turns,
      env_tool_calls: t.env_tool_calls,
      duration_ms: t.duration_ms,
      totals: {
        input: t.input_tokens,
        cached_input: t.cached_input_tokens,
        cache_write_input: t.cache_write_input_tokens,
        output: t.output_tokens,
        reasoning_output: t.reasoning_output_tokens,
      },
      calls: [],
      cost_cents: t.cost_cents,
    };
    trials_by_task.set(t.task_name, [
      ...(trials_by_task.get(t.task_name) ?? []),
      stored,
    ]);
  }
  return {
    suite: row,
    task_names: tasks.map((t) => t.task_name).sort(),
    next_pass: last?.pass == null ? 0 : last.pass + 1,
    trials_by_task,
  };
}

/** The driver, target, and count an append runs with: the suite's own. A
 *  flag that disagrees is an error rather than a silent switch, since the new
 *  trials are scored as part of the same run; --count may only raise the
 *  count. The target is looked up again and must still be the model the
 *  suite ran. */
export function appendLaunch(
  stored: StoredSuite,
  flags: { suite_key: string; driver?: string; target?: string; count?: number }
): { driver: string; target: string; count: number } {
  const mismatch = (what: string, given: string, has: string) =>
    new Error(
      `--append ${stored.id}: that suite ran ${what} ${has}, not ${given}`
    );
  if (flags.suite_key !== stored.name) {
    throw mismatch("suite", flags.suite_key, stored.name);
  }
  if (flags.driver !== undefined && flags.driver !== stored.driver_name) {
    throw mismatch("driver", flags.driver, stored.driver_name);
  }
  if (flags.target !== undefined && flags.target !== stored.target_name) {
    throw mismatch("target", flags.target, stored.target_name);
  }
  const count = flags.count ?? stored.count;
  if (count < stored.count) {
    throw new Error(
      `--append ${stored.id}: --count ${count} is below the suite’s count ${stored.count}; an append can only raise it`
    );
  }
  return {
    driver: stored.driver_name,
    target: stored.target_name,
    count,
  };
}

/** Throws when targets.json no longer maps the suite's target name to the
 *  model it ran. */
export function assertSameTarget(stored: StoredSuite, target: Target): void {
  const was = `${stored.provider}/${stored.model}@${stored.reasoning_effort ?? "-"}`;
  const now = `${target.provider}/${target.model}@${target.reasoning_effort ?? "-"}`;
  if (was !== now) {
    throw new Error(
      `--append ${stored.id}: target ${stored.target_name} is now ${now}, but the suite ran ${was}`
    );
  }
}
