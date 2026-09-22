import { AsyncLocalStorage } from "node:async_hooks";
import {
  readTestDatabaseUrl,
  readVitestPoolId,
  testWorkerDatabaseUrl,
} from "@context-cup/shared/test_database.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import z from "zod";
import { relations } from "./relations.ts";
import * as schema from "./schema.ts";

function assertVitestDatabaseIsolation(): void {
  if (process.env.VITEST !== "true") return;

  const poolId = readVitestPoolId();
  const testDatabaseUrl = readTestDatabaseUrl();
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Vitest database isolation is not configured. The shared Vitest setup must run before database code is imported."
    );
  }

  const expectedDatabaseUrl = testWorkerDatabaseUrl(testDatabaseUrl, poolId);

  if (databaseUrl !== expectedDatabaseUrl) {
    throw new Error(
      "Vitest database isolation is inconsistent. DATABASE_URL must match the current worker database derived from TEST_DATABASE_URL."
    );
  }
}

assertVitestDatabaseIsolation();

const { DATABASE_URL } = z
  .object({
    DATABASE_URL: z.string(),
  })
  .parse(process.env);

const pool = new Pool({
  connectionString: DATABASE_URL,
});

export const db = drizzle({
  client: pool,
  schema,
  relations,
  casing: "snake_case",
});

// The current transaction, if any, so getCurrentTransaction() can hand it to
// code that does not take a tx parameter.
type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionInstance = Parameters<TransactionCallback>[0];
const transactionStorage = new AsyncLocalStorage<TransactionInstance>();

/**
 * The database handle for the current context: the open transaction when
 * called inside withTransaction, otherwise the plain connection.
 */
export function getCurrentTransaction(): typeof db {
  const tx = transactionStorage.getStore();
  return (tx ?? db) as typeof db;
}

/** The underlying connection, bypassing any open transaction. */
export function getRawDatabase(): typeof db {
  return db;
}

export type DbPoolStats = {
  total: number;
  idle: number;
  waiting: number;
  max: number;
};

/** Connection-pool counters as of this moment. */
export function getPoolStats(): DbPoolStats {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options.max,
  };
}

/** Round-trip a trivial query through the pool. */
export async function pingDb(): Promise<void> {
  await pool.query("SELECT 1");
}

/** Close the pool. Call on shutdown. */
export async function closeDb(): Promise<void> {
  if (!pool.ended) {
    await pool.end();
  }
}

/**
 * Run `callback` inside a transaction. Nested calls reuse the outer
 * transaction, so there is at most one per async context. Never BEGIN or
 * ROLLBACK by hand; Drizzle manages the connection for db.transaction().
 */
export function withTransaction<T>(
  callback: Parameters<typeof db.transaction>[0]
): Promise<T> {
  const currentTx = transactionStorage.getStore();
  if (currentTx) {
    return callback(currentTx) as Promise<T>;
  }

  return db.transaction(async (tx) => {
    return transactionStorage.run(tx, () => callback(tx));
  }) as Promise<T>;
}
