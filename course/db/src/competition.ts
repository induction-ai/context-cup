/** The competition's rule as rows: `competition_suite` and
 *  `competition_task`, which the `run_eligibility` view judges by. The rule
 *  itself is course/shared/src/competition.ts; `bin/db migrate` copies it
 *  here after applying migrations, so the database judges by the rule of the
 *  code that was last deployed. */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BENCHMARK_SUITES,
  BENCHMARK_TASKS,
  ELIGIBILITY,
  REFERENCE_TARGET,
} from "@context-cup/shared/competition.js";
import { zProvider, type Provider } from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import z from "zod";
import { competitionSuite, competitionTask } from "./schema.ts";

export type CompetitionFacts = {
  suite_name: string;
  target_name: string;
  provider: Provider;
  min_done: number;
  tasks: readonly string[];
};

/** The provider of a target in targets.json (or TARGETS_FILE). */
function targetProvider(name: string): Provider {
  const file = process.env.TARGETS_FILE
    ? path.resolve(process.env.TARGETS_FILE)
    : path.join(REPO_ROOT, "targets.json");
  const targets = z
    .record(z.string(), z.object({ provider: zProvider }).loose())
    .parse(JSON.parse(readFileSync(file, "utf8")));
  const target = targets[name];
  if (!target) throw new Error(`${file} has no target ${name}`);
  return target.provider;
}

/** What competition.ts says the competition judges. */
export function competitionFacts(): CompetitionFacts[] {
  const provider = targetProvider(REFERENCE_TARGET);
  return BENCHMARK_SUITES.map((suite_name) => ({
    suite_name,
    target_name: REFERENCE_TARGET,
    provider,
    min_done: ELIGIBILITY.min_done,
    tasks: BENCHMARK_TASKS[suite_name],
  }));
}

/** Replace the competition tables with `facts`, as a whole: they are a copy
 *  of the rule, not history. Call inside a transaction. */
export async function writeCompetition(
  db: Pick<NodePgDatabase, "insert" | "delete">,
  facts: CompetitionFacts[]
): Promise<void> {
  await db.delete(competitionSuite);
  for (const c of facts) {
    await db.insert(competitionSuite).values({
      suite_name: c.suite_name,
      target_name: c.target_name,
      provider: c.provider,
      min_done: c.min_done,
    });
    if (c.tasks.length > 0) {
      await db.insert(competitionTask).values(
        c.tasks.map((task_name) => ({
          suite_name: c.suite_name,
          task_name,
        }))
      );
    }
  }
}
