/** `bin/drivers sync`: writes every runnable driver in the workspace, with
 *  its fingerprint, to the `driver` table, which the `driver_status` view
 *  reads. The Render cron runs it on main; it is safe to run anywhere, any
 *  number of times, and rewrites only what changed. (The competition's rule
 *  is written by `bin/db migrate`, from the deployed code.) */

import {
  getCurrentTransaction,
  withTransaction,
} from "@context-cup/db/connection.js";
import { driver } from "@context-cup/db/schema.js";
import type { Provider } from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { driverFingerprint } from "./fingerprint.ts";
import { driverProviders, isRunnable, type CupPackage } from "./packages.ts";

export type DriverFacts = {
  name: string;
  kind: "driver" | "agent";
  extends: string | null;
  providers: Provider[];
  description: string | null;
  fingerprint: string;
};

/** Every runnable driver in the workspace, as the `driver` table holds it. */
export function scanDrivers(
  packages: ReadonlyMap<string, CupPackage>,
  root: string = REPO_ROOT
): DriverFacts[] {
  return [...packages.values()]
    .filter(isRunnable)
    .map((p) => ({
      name: p.name,
      kind: p.kind as "driver" | "agent",
      extends: p.extends ?? null,
      providers: driverProviders(p.name, packages),
      description: p.description ?? null,
      fingerprint: driverFingerprint(p.name, packages, root),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type SyncReport = {
  added: string[];
  changed: string[];
  /** Back in the tree after being marked removed. */
  restored: string[];
  removed: string[];
  unchanged: string[];
};

export async function syncDrivers(inputs: {
  drivers: DriverFacts[];
  git_sha: string | null;
  now?: Date;
}): Promise<SyncReport> {
  const { drivers, git_sha, now = new Date() } = inputs;
  // An empty scan is a broken checkout, not a field with no entrants; syncing
  // it would mark every driver removed.
  if (drivers.length === 0) throw new Error("No drivers found; nothing synced");
  const report: SyncReport = {
    added: [],
    changed: [],
    restored: [],
    removed: [],
    unchanged: [],
  };
  await withTransaction(async () => {
    const db = getCurrentTransaction();
    const existing = new Map(
      (await db.select().from(driver)).map((row) => [row.name, row])
    );
    for (const facts of drivers) {
      const row = existing.get(facts.name);
      if (!row) {
        await db.insert(driver).values({
          ...facts,
          git_sha,
          first_seen_at: now,
          changed_at: null,
          synced_at: now,
          removed_at: null,
        });
        report.added.push(facts.name);
        continue;
      }
      const changed = row.fingerprint !== facts.fingerprint;
      await db
        .update(driver)
        .set({
          ...facts,
          git_sha,
          synced_at: now,
          removed_at: null,
          ...(changed ? { changed_at: now } : {}),
        })
        .where(eq(driver.name, facts.name));
      if (row.removed_at) report.restored.push(facts.name);
      else if (changed) report.changed.push(facts.name);
      else report.unchanged.push(facts.name);
    }

    const present = drivers.map((d) => d.name);
    const gone = await db
      .update(driver)
      .set({ removed_at: now, synced_at: now })
      .where(and(isNull(driver.removed_at), notInArray(driver.name, present)))
      .returning({ name: driver.name });
    report.removed.push(...gone.map((g) => g.name).sort());
  });
  return report;
}
