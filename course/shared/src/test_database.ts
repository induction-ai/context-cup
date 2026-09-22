const DEFAULT_TEST_DATABASE_URL = "postgres://localhost:5432/context_cup_test";

function parseTestDatabaseUrl(testDatabaseUrl: string): URL {
  try {
    return new URL(testDatabaseUrl);
  } catch (cause) {
    throw new Error("TEST_DATABASE_URL must be a valid database URL.", {
      cause,
    });
  }
}

export function readTestDatabaseUrl(): string {
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  parseTestDatabaseUrl(testDatabaseUrl);
  return testDatabaseUrl;
}

export function readVitestPoolId(): number {
  const poolId = process.env.VITEST_POOL_ID;
  const workerId = Number(poolId);
  if (
    !poolId ||
    !/^[1-9]\d*$/.test(poolId) ||
    !Number.isSafeInteger(workerId)
  ) {
    throw new Error("VITEST_POOL_ID must be a positive integer.");
  }
  return workerId;
}

export function testAdminDatabaseUrl(testDatabaseUrl: string): string {
  const url = parseTestDatabaseUrl(testDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function workerDatabaseUrl(testDatabaseUrl: string, poolId: number): URL {
  const url = parseTestDatabaseUrl(testDatabaseUrl);
  url.pathname = `${url.pathname}_${poolId}`;
  return url;
}

export function testWorkerDatabaseUrl(
  testDatabaseUrl: string,
  poolId: number
): string {
  return workerDatabaseUrl(testDatabaseUrl, poolId).toString();
}

export function testWorkerDatabaseName(
  testDatabaseUrl: string,
  poolId: number
): string {
  return workerDatabaseUrl(testDatabaseUrl, poolId).pathname.slice(1);
}
