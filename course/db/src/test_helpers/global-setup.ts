// Runs once before all test files and prepares one database per Vitest worker.
import "@context-cup/shared/load_env.js";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  readTestDatabaseUrl,
  testAdminDatabaseUrl,
  testWorkerDatabaseName,
  testWorkerDatabaseUrl,
} from "@context-cup/shared/test_database.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { escapeIdentifier, Pool } from "pg";
import z from "zod";
import { applyMigrations, dropAllTables } from "../migrations.ts";

const seed_sql_path = join(import.meta.dirname, "../../sql/seed.sql");

const TEST_DATABASE_URL = readTestDatabaseUrl();

const { TEST_WORKERS } = z
  .object({
    TEST_WORKERS: z.coerce.number().int().positive().optional(),
  })
  .parse(process.env);

const numWorkers = TEST_WORKERS ?? Math.max(1, os.availableParallelism() - 1);

export async function setup(): Promise<void> {
  const admin = new Pool({
    connectionString: testAdminDatabaseUrl(TEST_DATABASE_URL),
  });
  const seedDataSql = readFileSync(seed_sql_path, "utf8");

  try {
    for (let i = 1; i <= numWorkers; i++) {
      const name = testWorkerDatabaseName(TEST_DATABASE_URL, i);
      const exists = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [name]
      );
      if (exists.rows.length === 0) {
        await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
        console.log(`Created worker database: ${name}`);
      }
    }
  } finally {
    await admin.end();
  }

  // Prepare all workers in parallel so the suite starts from the same schema and data.
  await Promise.all(
    Array.from({ length: numWorkers }, async (_, i) => {
      const pool = new Pool({
        connectionString: testWorkerDatabaseUrl(TEST_DATABASE_URL, i + 1),
      });
      try {
        const database = drizzle({ client: pool });
        await dropAllTables(database);
        await applyMigrations(database);
        if (seedDataSql.trim()) await pool.query(seedDataSql);
      } finally {
        await pool.end();
      }
    })
  );

  console.log(`Prepared ${numWorkers} worker databases for parallel testing`);
}

export async function teardown(): Promise<void> {
  // Each worker process closes its own database pool on exit.
}
