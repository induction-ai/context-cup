import { zBooleanEnv } from "@context-cup/shared/node_env.js";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import z from "zod";

// drizzle-kit bundles this file to CommonJS, where import.meta is empty, so
// the workspace root cannot come from repo_root.ts. drizzle-kit always runs
// from this package directory (bin/db cd's here), hence the fixed path.
config({ path: "../../.env", quiet: true });

const { DEBUG, DATABASE_URL } = z
  .object({
    DEBUG: zBooleanEnv,
    DATABASE_URL: z.string(),
  })
  .parse(process.env);

export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  introspect: {
    casing: "preserve",
  },
  schemaFilter: ["public"],
  verbose: DEBUG,
  migrations: {
    table: "drizzle_migrations",
    schema: "public",
  },
  dbCredentials: {
    url: DATABASE_URL,
  },
});
