/**
 * bin/daytona_sweep: delete Daytona sandboxes that nothing will reclaim.
 *
 *   bin/daytona_sweep suite  --suite_id <id> [--dry_run]
 *   bin/daytona_sweep errors [--older_than_hours N] [--dry_run]
 *
 * suite  deletes every sandbox labelled with one bin/suite run. It runs after
 *        the suite finishes, including when the job was cancelled: a killed
 *        harbor never deletes its own sandboxes.
 * errors deletes context-cup sandboxes whose build failed. Auto-stop only
 *        reclaims sandboxes that reached a running state, so these pile up
 *        until something deletes them. Sandboxes without context-cup's suite
 *        label are never touched, so a shared organization is safe to sweep.
 *
 * Both are safe to run when there is nothing to delete.
 */
import "@context-cup/shared/load_env.js";
import yargs from "yargs";
import {
  daytonaClient,
  deleteSandboxes,
  listSandboxes,
  olderThan,
  reserved,
  SUITE_LABEL,
  type DaytonaClient,
  type Sandbox,
} from "./daytona.ts";

function describe(sandboxes: readonly Sandbox[]): string {
  const { cpu, memory, disk } = reserved(sandboxes);
  return `${sandboxes.length} sandbox(es), ${cpu} vCPU / ${memory} GB memory / ${disk} GB disk`;
}

async function sweep(
  client: DaytonaClient,
  sandboxes: Sandbox[],
  dry_run: boolean
): Promise<void> {
  if (sandboxes.length === 0) {
    console.log("nothing to delete");
    return;
  }
  console.log(
    `${dry_run ? "would delete" : "deleting"} ${describe(sandboxes)}`
  );
  if (dry_run) {
    for (const s of sandboxes)
      console.log(`  ${s.id} ${s.state} ${s.createdAt}`);
    return;
  }
  const { deleted, failed } = await deleteSandboxes(
    client,
    sandboxes.map((s) => s.id)
  );
  console.log(`deleted ${deleted.length}, failed ${failed.size}`);
  for (const [id, reason] of failed) console.log(`  ${id}: ${reason}`);
  // A partial sweep still leaves quota held; the CI cleanup step should show
  // that rather than pass.
  if (failed.size > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = yargs(process.argv.slice(2))
    .scriptName("bin/daytona_sweep")
    .command("suite", "Delete every sandbox of one suite run", (y) =>
      y.option("suite_id", { type: "string", demandOption: true })
    )
    .command("errors", "Delete context-cup sandboxes whose build failed", (y) =>
      y.option("older_than_hours", {
        type: "number",
        default: 12,
        describe: "Only sandboxes created longer ago than this",
      })
    )
    .demandCommand(1)
    .option("dry_run", {
      type: "boolean",
      default: false,
      describe: "List what would be deleted; delete nothing",
    })
    .alias("h", "help")
    .strict()
    .parseSync();

  const client = daytonaClient();
  if (argv._[0] === "suite") {
    const labels = { [SUITE_LABEL]: String(argv.suite_id) };
    await sweep(client, await listSandboxes(client, { labels }), argv.dry_run);
    return;
  }
  const hours = Number(argv.older_than_hours);
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error("--older_than_hours must be a non-negative number");
  }
  const failed_builds = await listSandboxes(client, { state: "error" });
  const ours = failed_builds.filter((s) => s.labels?.[SUITE_LABEL]);
  await sweep(client, olderThan(ours, hours), argv.dry_run);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
