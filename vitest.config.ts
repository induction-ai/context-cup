import { defineConfig } from "vitest/config";

// One suite for the whole workspace: one worker pool and one database
// provisioning (globalSetup) shared by every project. Run it via bin/test;
// filter with file paths or --project <name>.
const testDatabaseEnvironment =
  "course/shared/src/test_helpers/test_database_environment.ts";

export default defineConfig({
  test: {
    passWithNoTests: true,
    globalSetup: ["course/db/src/test_helpers/global-setup.ts"],
    projects: [
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
    ],
  },
});
