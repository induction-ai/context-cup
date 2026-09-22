import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

type MigrationDatabase = Parameters<typeof migrate>[0];

const migrations_directory = join(import.meta.dirname, "../drizzle");

export function listMigrationFolders(): string[] {
  return (
    readdirSync(migrations_directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Timestamp-prefixed folder names sort in the order Drizzle applies them.
      .sort()
  );
}

export function migrationPath(...parts: string[]): string {
  return join(migrations_directory, ...parts);
}

export async function applyMigrations(
  database: MigrationDatabase,
  migrationsFolder = migrations_directory
): Promise<void> {
  await migrate(database, {
    migrationsFolder,
    migrationsTable: "drizzle_migrations",
    migrationsSchema: "public",
  });
}

export async function dropAllTables(
  database: MigrationDatabase
): Promise<void> {
  const dropSql = readFileSync(
    join(import.meta.dirname, "../sql/drop_tables.sql"),
    "utf8"
  );
  await database.execute(sql.raw(dropSql));
}
