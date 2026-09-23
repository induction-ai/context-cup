import { defineConfig } from "vitest/config";

// One suite for the whole workspace: one worker pool and one database
// provisioning (globalSetup) shared by every project. Run it via bin/test;
// filter with file paths or --project <name>.
const testDatabaseEnvironment =
  "course/shared/src/test_helpers/test_database_environment.ts";

// TEST_WORKERS caps both the worker databases the global setup prepares and
// the vitest workers that use them, so a worker never lands on a database
// that was not created.
const maxWorkers = Number(process.env.TEST_WORKERS);

export default defineConfig({
  test: {
    passWithNoTests: true,
    ...(Number.isInteger(maxWorkers) && maxWorkers > 0 ? { maxWorkers } : {}),
    globalSetup: ["course/db/src/test_helpers/global-setup.ts"],
    projects: [
      {
        test: {
          name: "model-stats",
          root: "course/model-stats",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
        },
      },
      {
        test: {
          name: "db",
          root: "course/db",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
          setupFiles: [
            `../../${testDatabaseEnvironment}`,
            "src/test_helpers/setup.ts",
          ],
          sequence: { setupFiles: "list" },
        },
      },
      {
        test: {
          name: "site",
          root: "course/site",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["node_modules", ".next"],
          setupFiles: [
            `../../${testDatabaseEnvironment}`,
            "../db/src/test_helpers/setup.ts",
          ],
          sequence: { setupFiles: "list" },
        },
      },
      {
        test: {
          name: "suite",
          root: "course/suite",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["node_modules", "dist"],
          setupFiles: [
            `../../${testDatabaseEnvironment}`,
            "../db/src/test_helpers/setup.ts",
          ],
          sequence: { setupFiles: "list" },
        },
      },
    ],
  },
});
