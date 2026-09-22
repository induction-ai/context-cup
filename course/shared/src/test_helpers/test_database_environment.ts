// Points DATABASE_URL at this worker's own database before any package
// imports the connection, so parallel test files never share a database.
import "../load_env.ts";
import {
  readTestDatabaseUrl,
  readVitestPoolId,
  testWorkerDatabaseUrl,
} from "../test_database.ts";

const TEST_DATABASE_URL = readTestDatabaseUrl();
const poolId = readVitestPoolId();

process.env.DATABASE_URL = testWorkerDatabaseUrl(TEST_DATABASE_URL, poolId);
