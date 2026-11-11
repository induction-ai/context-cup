/**
 * bin/db_allow_list: let one Suite run's runner reach the deployed database,
 * which takes no connections from the internet otherwise (see allow_list.ts).
 *
 *   bin/db_allow_list open  --run <id> --ip <address>
 *   bin/db_allow_list close --run <id>
 *
 * open  returns once the runner can connect with DATABASE_URL, since Render
 *       may take a moment to apply the list.
 * close is safe to run when the run never opened.
 */
import "@context-cup/shared/load_env.js";
import { Client } from "pg";
import yargs from "yargs";
import {
  changeAllowList,
  hasRun,
  renderClient,
  runEntry,
  withoutRun,
} from "./allow_list.ts";

/** Wait for a connection, up to `timeout_ms`. */
async function awaitDatabase(url: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  for (;;) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(
          `the database is still unreachable: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const argv = yargs(process.argv.slice(2))
    .scriptName("bin/db_allow_list")
    .command("open", "Add this run's runner to the allow list", (y) =>
      y.option("ip", { type: "string", demandOption: true })
    )
    .command("close", "Remove this run's runner from the allow list")
    .demandCommand(1)
    .option("run", {
      type: "string",
      demandOption: true,
      describe: "The workflow run's id; a re-run of it replaces its entry",
    })
    .alias("h", "help")
    .strict()
    .parseSync();

  const client = renderClient();
  const run = argv.run;
  const now = new Date();
  if (argv._[0] === "open") {
    const database_url = process.env.DATABASE_URL;
    if (!database_url) throw new Error("DATABASE_URL is not set");
    const entry = runEntry(run, String(argv.ip), now);
    await changeAllowList(client, {
      apply: (list) => [...withoutRun(list, run, now), entry],
      holds: (list) => hasRun(list, run),
    });
    console.log(`allowed ${entry.cidrBlock} (${entry.description})`);
    await awaitDatabase(database_url, 120_000);
    console.log("the database is reachable");
    return;
  }
  await changeAllowList(client, {
    apply: (list) => withoutRun(list, run, now),
    holds: (list) => !hasRun(list, run),
  });
  console.log(`removed run ${run} from the allow list`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
