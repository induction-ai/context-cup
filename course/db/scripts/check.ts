/**
 * `bin/db check` — verify that migrations, snapshots, and schema.ts agree.
 *
 * Four checks:
 *   1. Every drizzle/ folder contains migration.sql and snapshot.json.
 *   2. Snapshot prevIds form one linear chain (parallel PRs generated off the
 *      same parent snapshot merge into a fork that makes `generate` emit
 *      duplicate migrations; per-PR CI cannot see the fork, only this can).
 *   3. The newest snapshot matches schema.ts (a `generate` would be a no-op).
 *   4. Replaying every migration.sql into an empty scratch database yields a
 *      schema with no diff against schema.ts.
 *
 * With 1–3 passing, check 4 transitively confirms migrations match the
 * snapshot as well. Checks 1–3 are file-only; check 4 creates and drops a
 * scratch database on the DATABASE_URL server.
 */
import "@context-cup/shared/load_env.js";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as DrizzleKitApi from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import yargs from "yargs";
import z from "zod";
import {
  applyMigrations,
  listMigrationFolders,
  migrationPath,
} from "../src/migrations.ts";
import * as schema from "../src/schema.ts";

// drizzle-kit 1.0.0-beta.9's ESM bundle declares `createRequire` twice and
// fails to parse; the CJS build is fine, so load it through require.
const kitRequire = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration, pushSchema } = kitRequire(
  "drizzle-kit/api-postgres"
) as typeof DrizzleKitApi;

// generateMigration and pushSchema hardwire drizzle-kit's interactive
// "created or renamed?" resolver, which renders a TTY prompt whenever a
// create/delete pair could be a rename — and exits 0 without a TTY. Replace
// the resolver in every prompts-* chunk with one that always answers
// "created": this tool only needs to know whether the diff is empty, and any
// rename ambiguity already means the check failed.
function neverRename(_entity: string, _defaultSchema?: string) {
  return async <T>(it: { created: T[]; deleted: T[] }) => ({
    created: it.created,
    deleted: it.deleted,
    renamedOrMoved: [] as { from: T; to: T }[],
  });
}
{
  const kitDir = join(kitRequire.resolve("drizzle-kit/api-postgres"), "..");
  let patched = 0;
  for (const file of readdirSync(kitDir)) {
    if (!/^prompts-.*\.js$/.test(file)) continue;
    const mod = kitRequire(join(kitDir, file)) as { resolver?: unknown };
    try {
      mod.resolver = neverRename;
    } catch {
      // The chunk exporting resolver via a non-writable getter is not the one
      // api-postgres.js loads; only the plain re-export needs to take.
    }
    if (mod.resolver === neverRename) patched += 1;
  }
  if (patched === 0) {
    throw new Error(
      "Could not replace drizzle-kit's interactive rename resolver — its chunk layout changed; update check.ts before trusting this check."
    );
  }
}

yargs(process.argv.slice(2))
  .scriptName("bin/db check")
  .usage(
    "Usage: $0\n\nVerify migrations, snapshots, and schema.ts agree: folder shape, snapshot chain, snapshot-vs-schema drift, and a migration replay into a scratch database."
  )
  .alias("h", "help")
  .strict()
  .parseSync();

const { DATABASE_URL } = z
  .object({
    DATABASE_URL: z.string(),
  })
  .parse(process.env);

const GENESIS_ID = "00000000-0000-0000-0000-000000000000";

type Snapshot = Awaited<ReturnType<typeof generateDrizzleJson>>;

const folders = listMigrationFolders();

let failures = 0;

function pass(message: string) {
  console.log(`[✓] ${message}`);
}

function fail(message: string, details: string[] = []) {
  failures += 1;
  console.log(`[✗] ${message}`);
  for (const detail of details) {
    console.log(`      ${detail}`);
  }
}

function checkFolders(): void {
  const broken = folders.flatMap((folder) => {
    const missing = ["migration.sql", "snapshot.json"].filter(
      (file) => !existsSync(migrationPath(folder, file))
    );
    return missing.length > 0
      ? [`${folder}: missing ${missing.join(", ")}`]
      : [];
  });
  if (broken.length === 0) {
    pass(
      `All ${folders.length} migration folders have migration.sql and snapshot.json.`
    );
  } else {
    fail(
      "Malformed migration folders (an aborted `bin/db generate` leaves an empty one — delete it):",
      broken
    );
  }
}

function readSnapshot(folder: string): Snapshot {
  const raw = readFileSync(migrationPath(folder, "snapshot.json"), "utf8");
  return JSON.parse(raw) as Snapshot;
}

function checkChain(): Snapshot | undefined {
  const snapshots = folders
    .filter((folder) => existsSync(migrationPath(folder, "snapshot.json")))
    .map((folder) => ({ folder, snapshot: readSnapshot(folder) }));
  const newest = snapshots.at(-1);
  if (newest === undefined) {
    if (folders.length === 0) {
      pass("No migrations yet; the replay check below covers schema.ts.");
    } else {
      fail("No snapshots found under drizzle/.");
    }
    return undefined;
  }

  const errors: string[] = [];
  let expectedPrev = GENESIS_ID;
  let prevFolder = "genesis";
  for (const { folder, snapshot } of snapshots) {
    if (!snapshot.prevIds.includes(expectedPrev)) {
      errors.push(
        `${folder} does not point at its predecessor ${prevFolder} — it was generated off a different parent (parallel branches merged?)`
      );
    }
    expectedPrev = snapshot.id;
    prevFolder = folder;
  }
  if (errors.length === 0) {
    pass("Snapshot chain is linear: every snapshot points at its predecessor.");
  } else {
    fail("Snapshot chain is broken:", errors);
  }
  return newest.snapshot;
}

async function checkSchemaDrift(newest: Snapshot): Promise<void> {
  const current = await generateDrizzleJson(
    { ...schema },
    newest.id,
    ["public"],
    "snake_case"
  );
  const statements = await generateMigration(newest, current);
  if (statements.length === 0) {
    pass(
      "Newest snapshot matches schema.ts — `bin/db generate` would be a no-op."
    );
  } else {
    fail(
      "Newest snapshot has drifted from schema.ts — `bin/db generate` would emit:",
      statements
    );
  }
}

async function checkMigrationReplay(): Promise<void> {
  const scratchName = `drizzle_check_${randomBytes(6).toString("hex")}`;
  // DROP DATABASE ... WITH (FORCE) terminates any connection still open on the
  // scratch database; a killed idle client emits "error" on its pool, which is
  // fatal to the process unless a listener exists.
  const swallowPoolError = () => {};
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  adminPool.on("error", swallowPoolError);
  try {
    await adminPool.query(`CREATE DATABASE "${scratchName}"`);
    try {
      const scratchUrl = new URL(DATABASE_URL);
      scratchUrl.pathname = `/${scratchName}`;
      const scratchPool = new Pool({ connectionString: scratchUrl.toString() });
      scratchPool.on("error", swallowPoolError);
      try {
        await applyMigrations(drizzle({ client: scratchPool }));
        const { sqlStatements } = await pushSchema(
          { ...schema },
          drizzle({ client: scratchPool }),
          "snake_case",
          undefined,
          { table: "drizzle_migrations", schema: "public" }
        );
        if (sqlStatements.length === 0) {
          pass(
            "Replaying all migration.sql files produces exactly the schema in schema.ts."
          );
        } else {
          fail(
            "Replayed migrations diverge from schema.ts — a push would still need:",
            sqlStatements
          );
        }
      } finally {
        await scratchPool.end();
      }
    } finally {
      await adminPool.query(
        `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`
      );
    }
  } finally {
    await adminPool.end();
  }
}

async function main() {
  checkFolders();
  const newest = checkChain();
  if (newest !== undefined) {
    await checkSchemaDrift(newest);
  }
  await checkMigrationReplay();
  if (failures > 0) {
    console.log(`${failures} check${failures === 1 ? "" : "s"} failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
