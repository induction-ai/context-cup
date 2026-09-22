/**
 * `bin/db reset <migration>` drops every table in the public schema, then
 * re-runs migrations up to and including the named one (a folder under
 * drizzle/). Refuses to run outside development or against a remote host.
 */
import "@context-cup/shared/load_env.js";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNodeEnv } from "@context-cup/shared/node_env.js";
import { DrizzleQueryError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import yargs from "yargs";
import z from "zod";
import {
  applyMigrations,
  dropAllTables,
  listMigrationFolders,
  migrationPath,
} from "../src/migrations.ts";

const { DATABASE_URL } = z
  .object({
    DATABASE_URL: z.string(),
  })
  .parse(process.env);

const node_env = readNodeEnv();
if (node_env !== "development") {
  console.error(`Refusing to reset database in ${node_env} environment.`);
  process.exit(1);
}

const dbUrl = new URL(DATABASE_URL);
if (dbUrl.hostname !== "localhost" && dbUrl.hostname !== "127.0.0.1") {
  console.error(
    `Refusing to reset database: host "${dbUrl.hostname}" is not localhost.`
  );
  process.exit(1);
}

async function main() {
  const allMigrations = listMigrationFolders();

  const argv = yargs(process.argv.slice(2))
    .scriptName("bin/db reset")
    .usage(
      `Usage: $0 <migration>\n\nAvailable migrations:\n${allMigrations.map((m) => `  ${m}`).join("\n")}`
    )
    .command(
      "$0 <migration>",
      "Reset the database to a specific migration",
      (y) =>
        y.positional("migration", {
          type: "string",
          demandOption: true,
          describe: "Migration folder name under drizzle/",
        })
    )
    .option("dry_run", {
      type: "boolean",
      default: false,
      describe: "Print what would be done without modifying the database",
    })
    .option("prune", {
      type: "boolean",
      default: false,
      describe:
        "Delete migration folders after the target migration from drizzle/",
    })
    .alias("h", "help")
    .strict()
    .parseSync();

  const target = argv.migration as string;
  const targetIndex = allMigrations.indexOf(target);

  if (targetIndex === -1) {
    console.error(
      `Migration not found: ${target}\n\nAvailable migrations:\n${allMigrations.map((m) => `  ${m}`).join("\n")}`
    );
    process.exit(1);
  }

  const migrationsToApply = allMigrations.slice(0, targetIndex + 1);
  const migrationsToPrune = allMigrations.slice(targetIndex + 1);

  console.log(
    `Resetting database to migration: ${target} (${migrationsToApply.length}/${allMigrations.length} migrations)`
  );

  if (argv.dry_run) {
    console.log("Dry run: no changes made.");
    console.log(
      `Would drop all tables, then apply:\n${migrationsToApply.map((m) => `  ${m}`).join("\n")}`
    );
    if (argv.prune && migrationsToPrune.length > 0) {
      console.log(
        `Would delete from drizzle/:\n${migrationsToPrune.map((m) => `  ${m}`).join("\n")}`
      );
    }
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle({ client: pool });

  console.log("Dropping all objects in public schema...");
  try {
    await dropAllTables(db);
    console.log("Database cleared");
  } catch (error: unknown) {
    const database_error =
      error instanceof DrizzleQueryError ? error.cause : error;
    if (
      database_error instanceof Error &&
      "code" in database_error &&
      database_error.code === "3D000"
    ) {
      console.log("Database does not exist, nothing to clear");
    } else {
      throw error;
    }
  }

  // A temp directory holding symlinks to only the target migrations.
  const tmpMigrationsDir = mkdtempSync(join(tmpdir(), "drizzle-reset-"));
  try {
    for (const name of migrationsToApply) {
      symlinkSync(migrationPath(name), join(tmpMigrationsDir, name));
    }

    console.log(`Applying ${migrationsToApply.length} migrations...`);
    await applyMigrations(db, tmpMigrationsDir);
  } finally {
    rmSync(tmpMigrationsDir, { recursive: true });
  }

  if (argv.prune && migrationsToPrune.length > 0) {
    console.log(`Pruning ${migrationsToPrune.length} migration folders...`);
    for (const name of migrationsToPrune) {
      rmSync(migrationPath(name), { recursive: true });
    }
  }

  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
