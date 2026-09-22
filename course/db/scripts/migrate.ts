/**
 * `bin/db migrate` applies pending migrations and reports the applied count.
 */
import "@context-cup/shared/load_env.js";
import { setTimeout as sleep } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import yargs from "yargs";
import z from "zod";
import { applyMigrations } from "../src/migrations.ts";

// Drizzle's migrator holds no lock of its own; two runs starting from the same
// last-applied row would both try the same DDL.
const MIGRATION_LOCK_KEY = 4_073_913;

const LOCK_WAIT_MS = 60 * 60 * 1000;
const LOCK_POLL_MS = 5 * 1000;
const LOCK_REPORT_MS = 30 * 1000;

yargs(process.argv.slice(2))
  .scriptName("bin/db migrate")
  .usage("Usage: $0\n\nApply all pending migrations from drizzle/.")
  .alias("h", "help")
  .strict()
  .parseSync();

const { DATABASE_URL } = z
  .object({
    DATABASE_URL: z.string(),
  })
  .parse(process.env);

// Two queries: PG resolves both branches of a CASE at parse time, so a single
// query referencing the table would error before to_regclass can save it.
async function countApplied(client: Client): Promise<number> {
  const exists = await client.query<{ regclass: string | null }>(
    `SELECT to_regclass('public.drizzle_migrations') AS regclass`
  );
  if (exists.rows[0]?.regclass == null) return 0;
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM public.drizzle_migrations`
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function acquireMigrationLock(client: Client): Promise<void> {
  const started = Date.now();
  let reported: number | null = null;
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
      [MIGRATION_LOCK_KEY]
    );
    if (result.rows[0]?.locked === true) return;
    const waited = Date.now() - started;
    if (waited >= LOCK_WAIT_MS) {
      throw new Error(
        `Waited ${Math.round(waited / 60_000)} minutes for another migration to finish and gave up.`
      );
    }
    if (reported == null) {
      reported = waited;
      console.log("Another migration is in progress. Waiting for it.");
    } else if (waited - reported >= LOCK_REPORT_MS) {
      reported = waited;
      console.log(`Still waiting (${Math.round(waited / 1000)}s).`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

async function main() {
  // One connection for the whole run: the advisory lock belongs to the
  // connection that took it, and closing that connection releases it.
  const client = new Client({ connectionString: DATABASE_URL });
  client.on("error", (err) => {
    console.error(`Database connection lost: ${err.message}`);
  });
  await client.connect();
  try {
    await acquireMigrationLock(client);
    const before = await countApplied(client);
    await applyMigrations(drizzle({ client }));
    const applied = (await countApplied(client)) - before;
    console.log(
      applied === 0
        ? "[-] No DB migrations to apply."
        : `[✓] ${applied} DB migration${applied === 1 ? "" : "s"} applied successfully!`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
