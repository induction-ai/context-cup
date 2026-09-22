import { zBooleanEnv } from "@context-cup/shared/node_env.js";
import z from "zod";
import { withTransaction } from "../connection.ts";

const { LEAVEDB } = z
  .object({
    LEAVEDB: zBooleanEnv,
  })
  .parse(process.env);

/** Runs a test in a transaction that rolls back unless LEAVEDB is enabled. */
export async function with_test_transaction<T>(
  fn: () => Promise<T>
): Promise<T> {
  if (LEAVEDB) {
    return await fn();
  }

  const rollback = new Error("TEST_ROLLBACK");
  rollback.name = "TestRollbackError";

  try {
    return await withTransaction(async () => {
      const result = await fn();
      throw rollback;
      return result;
    });
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
    return undefined as T;
  }
}
