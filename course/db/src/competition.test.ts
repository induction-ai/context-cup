import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { competitionFacts, writeCompetition } from "./competition.ts";
import { getCurrentTransaction } from "./connection.ts";
import { competitionSuite, competitionTask } from "./schema.ts";

describe("competition", () => {
  it("reads the rule from competition.ts and targets.json", async () => {
    const facts = competitionFacts();
    expect(facts.map((f) => f.suite_name)).toEqual([
      "tau_banking",
      "toolathlon",
    ]);
    expect(facts[0]).toMatchObject({
      target_name: "gpt-6-sol@medium",
      provider: "openai",
      min_done: 2,
    });
    expect(facts[0]!.tasks.length).toBeGreaterThan(0);
  });

  it("replaces the tables as a whole", async () => {
    const db = getCurrentTransaction();
    const bench = {
      suite_name: "bench",
      target_name: "t",
      provider: "openai" as const,
      min_done: 2,
      tasks: ["a", "b"],
    };
    await writeCompetition(db, [bench, { ...bench, suite_name: "other" }]);
    await writeCompetition(db, [{ ...bench, tasks: ["c"] }]);
    expect(await db.select().from(competitionSuite)).toHaveLength(1);
    expect(await db.select().from(competitionTask)).toEqual([
      { suite_name: "bench", task_name: "c" },
    ]);
  });
});
