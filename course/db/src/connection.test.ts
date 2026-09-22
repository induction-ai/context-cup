import {
  readTestDatabaseUrl,
  readVitestPoolId,
  testWorkerDatabaseName,
} from "@context-cup/shared/test_database.js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "@context-cup/shared/test_helpers/index.js";
import { sql } from "drizzle-orm";
import type * as ConnectionModule from "./connection.ts";
import { getRawDatabase } from "./connection.ts";

async function importConnection(): Promise<typeof ConnectionModule> {
  vi.resetModules();
  return await vi.importActual<typeof ConnectionModule>("./connection.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("database connection in Vitest", () => {
  it("uses the current worker's test database", async () => {
    const testDatabaseUrl = readTestDatabaseUrl();
    const poolId = readVitestPoolId();

    const expectedDatabaseName = testWorkerDatabaseName(
      testDatabaseUrl,
      poolId
    );
    const result = await getRawDatabase().execute<{ name: string }>(
      sql`SELECT current_database() AS name`
    );

    expect(result.rows[0]?.name).toBe(expectedDatabaseName);
  });

  it("uses the default worker database when the test database URL is missing", async () => {
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    const databaseUrl = `postgres://localhost:5432/context_cup_test_${readVitestPoolId()}`;
    vi.stubEnv("DATABASE_URL", databaseUrl);

    const connection = await importConnection();
    try {
      expect(connection.getRawDatabase().$client.options.connectionString).toBe(
        databaseUrl
      );
    } finally {
      await connection.closeDb();
    }
  });

  it("refuses a missing database URL", async () => {
    vi.stubEnv("DATABASE_URL", undefined);

    await expect(importConnection()).rejects.toThrow(
      "Vitest database isolation is not configured"
    );
  });

  it("refuses an application database", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://application.example.invalid:5432/application"
    );

    await expect(importConnection()).rejects.toThrow(
      "Vitest database isolation is inconsistent"
    );
  });

  it.each(["", "not-a-url"])(
    "refuses an invalid test database URL (%j)",
    async (testDatabaseUrl) => {
      vi.stubEnv("TEST_DATABASE_URL", testDatabaseUrl);

      await expect(importConnection()).rejects.toThrow(
        "TEST_DATABASE_URL must be a valid database URL"
      );
    }
  );

  it.each([undefined, "", "worker", "0", "-1", "1.5", "01", " 1"])(
    "refuses an invalid worker ID (%j)",
    async (poolId) => {
      vi.stubEnv("VITEST_POOL_ID", poolId);

      await expect(importConnection()).rejects.toThrow(
        "VITEST_POOL_ID must be a positive integer"
      );
    }
  );
});
