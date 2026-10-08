import "@context-cup/shared/load_env.js";
import { closeDb, getRawDatabase } from "@context-cup/db/connection.js";
import { driverStatus } from "@context-cup/db/schema.js";
import { asc, ne } from "drizzle-orm";
import yargs from "yargs";
import { scanDrivers, syncDrivers } from "./drivers.ts";
import { gitSha } from "./git.ts";
import { workspacePackages } from "./packages.ts";

async function sync(dry_run: boolean): Promise<void> {
  const drivers = scanDrivers(workspacePackages());
  const git_sha = gitSha();
  if (dry_run) {
    console.log(`at ${git_sha ?? "(unknown commit)"}:`);
    for (const d of drivers) {
      console.log(
        `  ${d.name.padEnd(24)} ${d.kind.padEnd(6)} ${d.providers.join(",").padEnd(24)} ${d.fingerprint.slice(0, 15)}`
      );
    }
    return;
  }
  const report = await syncDrivers({ drivers, git_sha });
  const line = (label: string, names: string[]) =>
    names.length > 0 && console.log(`${label}: ${names.join(", ")}`);
  console.log(
    `synced ${drivers.length} driver(s) at ${git_sha ?? "(unknown commit)"}`
  );
  line("added", report.added);
  line("changed", report.changed);
  line("restored", report.restored);
  line("removed", report.removed);
}

async function status(all: boolean, json: boolean): Promise<void> {
  const rows = await getRawDatabase()
    .select()
    .from(driverStatus)
    .where(all ? undefined : ne(driverStatus.status, "current"))
    .orderBy(asc(driverStatus.driver_name), asc(driverStatus.suite_name));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(all ? "no drivers synced yet" : "nothing owed");
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.driver_name.padEnd(24)} ${r.suite_name.padEnd(12)} ${r.target_name.padEnd(18)} ${r.status.padEnd(8)} ${detail(r)}`
    );
  }
}

/** The run a status line is about, and its score or why it doesn't count. */
function detail(r: typeof driverStatus.$inferSelect): string {
  if (r.running_suite_id && r.status === "running") {
    return `${r.running_suite_id} under way`;
  }
  if (r.standing_suite_id) {
    const score = r.mean_reward == null ? "unscored" : r.mean_reward.toFixed(3);
    const cost =
      r.run_cents == null ? "" : `, $${(r.run_cents / 100).toFixed(2)}/run`;
    return `${r.standing_suite_id} scored ${score}${cost}`;
  }
  if (!r.latest_suite_id) return "never run";
  const why: string[] = [];
  if (!r.latest_finished_at) why.push("not finished");
  if (r.latest_missing_tasks) {
    why.push(`missing ${r.latest_missing_tasks} of ${r.required_tasks} tasks`);
  }
  if ((r.latest_min_task_done ?? 0) < r.min_done) {
    why.push(
      `a task has ${r.latest_min_task_done ?? 0} done trials, needs ${r.min_done}`
    );
  }
  return `latest ${r.latest_suite_id} doesn’t count: ${why.join("; ")}`;
}

async function main(): Promise<void> {
  await yargs(process.argv.slice(2))
    .scriptName("bin/drivers")
    .usage(
      "Usage: $0 <command>\n\nThe driver registry: what drivers/ holds, and what each owes the competition."
    )
    .command(
      "sync",
      "Write every runnable driver and its fingerprint to the database",
      (y) =>
        y.option("dry_run", {
          type: "boolean",
          default: false,
          describe: "Print what would be written; write nothing",
        }),
      (argv) => sync(argv.dry_run)
    )
    .command(
      "status",
      "Where each driver stands on each competition suite (the driver_status view); by default only what isn’t current",
      (y) =>
        y
          .option("all", {
            type: "boolean",
            default: false,
            describe: "Include current entries",
          })
          .option("json", { type: "boolean", default: false }),
      (argv) => status(argv.all, argv.json)
    )
    .demandCommand(1)
    .alias("h", "help")
    .strict()
    .parseAsync();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
