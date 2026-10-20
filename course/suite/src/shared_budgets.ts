import { suiteBudgetHold } from "@context-cup/db/schema.js";
import { getTableName } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import z from "zod";

/** One budget a job draws from while it runs: the key every bin/suite on
 *  any machine agrees on, the capacity this run gives it, and how much of it
 *  the job uses. */
export type BudgetClaim = { key: string; capacity: number; weight: number };

/** A running job's share of one budget, as other machines see it. */
export type BudgetHold = {
  holder: string;
  invocation_id: string;
  job_id: string;
  weight: number;
};

export type BlockedBudget = {
  key: string;
  capacity: number;
  in_use: number;
  holds: BudgetHold[];
};

export type AcquireResult =
  | { admitted: true }
  | { admitted: false; blocked: BlockedBudget[] };

/** A running job whose holds could not be re-asserted: they had expired and
 *  another machine filled the budget in the meantime. */
export type LostHold = { job_id: string; blocked: BlockedBudget[] };

/** A hold whose owner has not re-asserted it for this long stops counting and
 *  is swept, so a machine that died mid-job frees its budget. */
export const HOLD_EXPIRY_MS = 4 * 60_000;
/** How often a running bin/suite re-asserts every hold it has. Well inside the
 *  expiry, so a few missed beats never lose a hold. */
export const HEARTBEAT_MS = 20_000;

/** The table in course/db/src/schema.ts; its migration creates it. */
export const HOLD_TABLE = getTableName(suiteBudgetHold);

/** Inserts one job's holds, or re-asserts them when they already exist. $1
 *  keys and $2 weights are parallel arrays; $3 job id, $4 invocation id, $5
 *  holder. */
const UPSERT_HOLDS = `
  INSERT INTO ${HOLD_TABLE} (budget_key, weight, job_id, invocation_id, holder)
  SELECT key, weight, $3, $4, $5
  FROM unnest($1::text[], $2::integer[]) AS hold(key, weight)
  ON CONFLICT (budget_key, invocation_id, job_id)
  DO UPDATE SET weight = EXCLUDED.weight, heartbeat_at = now()`;

const EXPIRY_SECONDS = HOLD_EXPIRY_MS / 1000;

/** The Postgres every bin/suite coordinates through: SUITE_DATABASE_URL, or
 *  the results database (DATABASE_URL) when that is unset. */
export function sharedBudgetsUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const { SUITE_DATABASE_URL, DATABASE_URL } = z
    .object({
      SUITE_DATABASE_URL: z.string().optional(),
      DATABASE_URL: z.string().optional(),
    })
    .parse(env);
  const url = SUITE_DATABASE_URL?.trim() || DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "bin/suite needs SUITE_DATABASE_URL or DATABASE_URL set: the Postgres every suite run, on any machine, shares its task and target budgets through"
    );
  }
  return url;
}

/** Who holds a budget, as another machine's log names it: the GitHub run,
 *  or the invocation. Never a user or host name: the log of a Suite workflow
 *  run is public, and it names every holder it waits on. */
export function defaultHolder(
  invocation_id: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (env.GITHUB_RUN_ID) return `github run ${env.GITHUB_RUN_ID}`;
  return `local run ${invocation_id}`;
}

function databaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * Budgets shared by every bin/suite run on every machine, kept in one Postgres
 * table. A job's claims are admitted all together or not at all. While the
 * job runs its holds are refreshed every heartbeat and count against the
 * budget for everyone else until released, or until the heartbeat stops for
 * HOLD_EXPIRY_MS. A hold that expired (this machine was asleep or offline) is
 * taken again only if the budget still has room; otherwise it is lost and
 * on_lost is told.
 */
export class SharedBudgets {
  /** Claims held per running job, refreshed by each heartbeat. */
  private readonly held = new Map<string, BudgetClaim[]>();
  private readonly timer: NodeJS.Timeout;
  private beating: Promise<void> | null = null;
  /** Heartbeats, releases, and close run one after another, so a heartbeat
   *  that is re-taking a job's holds never races the job's release and
   *  leaves rows nobody owns. */
  private serial: Promise<unknown> = Promise.resolve();
  on_lost: ((lost: LostHold) => void) | null = null;
  private readonly pool: Pool;
  private readonly report: (line: string) => void;
  readonly invocation_id: string;
  readonly holder: string;
  /** Host and database name, for logs. */
  readonly label: string;

  private constructor(options: {
    pool: Pool;
    invocation_id: string;
    holder: string;
    label: string;
    report: (line: string) => void;
  }) {
    this.pool = options.pool;
    this.invocation_id = options.invocation_id;
    this.holder = options.holder;
    this.label = options.label;
    this.report = options.report;
    this.timer = setInterval(() => {
      this.beating ??= this.heartbeat()
        .catch((err: unknown) => {
          this.report(
            `shared budgets: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(() => {
          this.beating = null;
        });
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  /** Connects and sweeps expired holds. Throws when the database cannot be
   *  reached or lacks the table, so a suite refuses to start rather than run
   *  blind to other machines. */
  static async open(options: {
    invocation_id: string;
    database_url: string;
    holder?: string;
    report?: (line: string) => void;
  }): Promise<SharedBudgets> {
    const label = databaseLabel(options.database_url);
    const pool = new Pool({ connectionString: options.database_url });
    try {
      const { rows } = await pool.query<{ exists: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [HOLD_TABLE]
      );
      if (!rows[0]?.exists) {
        throw new Error(
          `no ${HOLD_TABLE} table; run bin/db migrate against it`
        );
      }
      await sweepExpired(pool);
    } catch (err) {
      await pool.end();
      throw new Error(
        `shared budgets unavailable at ${label}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    return new SharedBudgets({
      pool,
      invocation_id: options.invocation_id,
      holder: options.holder ?? defaultHolder(options.invocation_id),
      label,
      report: options.report ?? ((line) => console.error(line)),
    });
  }

  /** Takes every claim for a job at once, or none when any budget lacks
   *  room; the refusal lists each full budget with who holds it. Budgets this
   *  process's own jobs already fill are refused without a round trip. */
  async acquire(job_id: string, claims: BudgetClaim[]): Promise<AcquireResult> {
    const own = findBlocked(this.ownHolds(job_id), claims);
    if (own.length > 0) return { admitted: false, blocked: own };
    const result = await this.assertHolds(job_id, claims);
    if (result.admitted) this.held.set(job_id, claims);
    return result;
  }

  release(job_id: string): Promise<void> {
    return this.serialized(async () => {
      this.held.delete(job_id);
      await this.deleteHolds(job_id);
    });
  }

  /** Refreshes every live hold of this invocation's running jobs in one
   *  statement, takes again any hold whose row expired or was swept, then
   *  sweeps holds other machines stopped refreshing. A job whose budget
   *  filled up while its hold was expired loses it: its rows go and on_lost
   *  is told. Only running jobs' rows are refreshed, so a row whose release
   *  failed expires like any other. */
  heartbeat(): Promise<void> {
    return this.serialized(async () => {
      const { rows } = await this.pool.query<{
        budget_key: string;
        job_id: string;
      }>(
        `UPDATE ${HOLD_TABLE} SET heartbeat_at = now()
         WHERE invocation_id = $1
           AND job_id = ANY($3)
           AND heartbeat_at > now() - make_interval(secs => $2)
         RETURNING budget_key, job_id`,
        [this.invocation_id, EXPIRY_SECONDS, [...this.held.keys()]]
      );
      const refreshed = new Set(
        rows.map((row) => `${row.job_id} ${row.budget_key}`)
      );
      for (const [job_id, claims] of this.held) {
        const intact = claims.every((claim) =>
          refreshed.has(`${job_id} ${claim.key}`)
        );
        if (intact) continue;
        const result = await this.assertHolds(job_id, claims);
        if (result.admitted) continue;
        this.held.delete(job_id);
        await this.deleteHolds(job_id);
        this.on_lost?.({ job_id, blocked: result.blocked });
      }
      await sweepExpired(this.pool);
    });
  }

  /** Drops every hold of this invocation and disconnects. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    try {
      await this.serialized(async () => {
        this.held.clear();
        await this.pool.query(
          `DELETE FROM ${HOLD_TABLE} WHERE invocation_id = $1`,
          [this.invocation_id]
        );
      });
    } finally {
      await this.pool.end();
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work);
    this.serial = next.catch(() => {});
    return next;
  }

  /** This process's holds other than the given job's, in the shape the
   *  database returns them. */
  private ownHolds(job_id: string): HoldRow[] {
    return [...this.held]
      .filter(([held_job]) => held_job !== job_id)
      .flatMap(([held_job, claims]) =>
        claims.map((claim) => ({
          budget_key: claim.key,
          holder: this.holder,
          invocation_id: this.invocation_id,
          job_id: held_job,
          weight: claim.weight,
        }))
      );
  }

  /** Writes the job's holds when every budget has room for them, counting
   *  everyone's live holds except this job's own (which the write replaces).
   *  Serves first admission and re-taking an expired hold. */
  private async assertHolds(
    job_id: string,
    claims: BudgetClaim[]
  ): Promise<AcquireResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Admission is checked then written, so it runs under one advisory lock
      // per budget, taken in a fixed order: two machines admitting against the
      // same budgets serialize instead of deadlocking or both squeezing in.
      // Row locks alone cannot do this, as an empty budget has no row to lock.
      const keys = [...new Set(claims.map((claim) => claim.key))].sort();
      for (const key of keys) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      }
      const others = await liveHoldsOfOthers(client, keys, {
        invocation_id: this.invocation_id,
        job_id,
      });
      const blocked = findBlocked(others, claims);
      if (blocked.length > 0) {
        await client.query("ROLLBACK");
        return { admitted: false, blocked };
      }
      await client.query(UPSERT_HOLDS, [
        claims.map((claim) => claim.key),
        claims.map((claim) => claim.weight),
        job_id,
        this.invocation_id,
        this.holder,
      ]);
      await client.query("COMMIT");
      return { admitted: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async deleteHolds(job_id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${HOLD_TABLE} WHERE invocation_id = $1 AND job_id = $2`,
      [this.invocation_id, job_id]
    );
  }
}

type HoldRow = {
  budget_key: string;
  holder: string;
  invocation_id: string;
  job_id: string;
  weight: number;
};

async function liveHoldsOfOthers(
  client: PoolClient,
  keys: string[],
  self: { invocation_id: string; job_id: string }
): Promise<HoldRow[]> {
  const { rows } = await client.query<HoldRow>(
    `SELECT budget_key, holder, invocation_id, job_id, weight FROM ${HOLD_TABLE}
     WHERE budget_key = ANY($1)
       AND heartbeat_at > now() - make_interval(secs => $2)
       AND NOT (invocation_id = $3 AND job_id = $4)
     ORDER BY acquired_at`,
    [keys, EXPIRY_SECONDS, self.invocation_id, self.job_id]
  );
  return rows;
}

function findBlocked(holds: HoldRow[], claims: BudgetClaim[]): BlockedBudget[] {
  const blocked: BlockedBudget[] = [];
  for (const claim of claims) {
    const held = holds.filter((hold) => hold.budget_key === claim.key);
    const in_use = held.reduce((sum, hold) => sum + hold.weight, 0);
    if (in_use + claim.weight <= claim.capacity) continue;
    blocked.push({
      key: claim.key,
      capacity: claim.capacity,
      in_use,
      holds: held.map(({ holder, invocation_id, job_id, weight }) => ({
        holder,
        invocation_id,
        job_id,
        weight,
      })),
    });
  }
  return blocked;
}

async function sweepExpired(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM ${HOLD_TABLE} WHERE heartbeat_at <= now() - make_interval(secs => $1)`,
    [EXPIRY_SECONDS]
  );
}
