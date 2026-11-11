/**
 * The deployed database's IP allow list on Render, opened to one Suite run's
 * runner for as long as the run lasts (bin/db_allow_list).
 *
 * Render's API replaces the whole list on every write, and Suite runs overlap,
 * so each run adds or removes only its own entry and reads the list back to
 * check that another run's write did not undo it. Two writes within about a
 * second of each other can still drop an entry; `open` catches that by
 * connecting to the database before the suite starts, but a drop later in the
 * run cuts the run off.
 *
 * An entry names the time it lapses, past the job's 6-hour limit, so the next
 * run removes an entry that a lost runner never closed. Entries not written
 * here (a maintainer's own address) are left as they are.
 */
import { z } from "zod";

export const RENDER_API = "https://api.render.com/v1";

/** How long an entry stays before any run may remove it: the Suite job's
 *  6-hour limit plus an hour for the steps around the run. */
export const ENTRY_LIFETIME_MS = 7 * 60 * 60 * 1000;

const zEntry = z.object({ cidrBlock: z.string(), description: z.string() });

export type Entry = z.infer<typeof zEntry>;

const zPostgres = z.object({ ipAllowList: z.array(zEntry) });

const DESCRIPTION = /^suite run (\S+) until (\S+)$/;

export type RenderClient = {
  key: string;
  postgres_id: string;
  fetch?: typeof fetch;
};

export function renderClient(env = process.env): RenderClient {
  const key = env.RENDER_API_KEY?.trim();
  const postgres_id = env.RENDER_POSTGRES_ID?.trim();
  if (!key) throw new Error("RENDER_API_KEY is not set");
  if (!postgres_id) throw new Error("RENDER_POSTGRES_ID is not set");
  return { key, postgres_id };
}

/** The entry that lets one run's runner in until `now` plus the lifetime. */
export function runEntry(run: string, ip: string, now: Date): Entry {
  const until = new Date(now.getTime() + ENTRY_LIFETIME_MS).toISOString();
  return {
    cidrBlock: `${ip}/32`,
    description: `suite run ${run} until ${until}`,
  };
}

/** `list` without `run`'s entries and without any run's lapsed ones. */
export function withoutRun(list: Entry[], run: string, now: Date): Entry[] {
  return list.filter((entry) => {
    const match = DESCRIPTION.exec(entry.description);
    if (!match) return true;
    return match[1] !== run && new Date(match[2]!).getTime() > now.getTime();
  });
}

export function hasRun(list: Entry[], run: string): boolean {
  return list.some((entry) => DESCRIPTION.exec(entry.description)?.[1] === run);
}

async function call(
  client: RenderClient,
  method: "GET" | "PATCH",
  body?: unknown
): Promise<Entry[]> {
  const response = await (client.fetch ?? fetch)(
    `${RENDER_API}/postgres/${client.postgres_id}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${client.key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );
  if (!response.ok) {
    throw new Error(
      `Render ${method} postgres: ${response.status} ${await response.text()}`
    );
  }
  return zPostgres.parse(await response.json()).ipAllowList;
}

export type Change = {
  /** The list to write, given the list as read. */
  apply: (list: Entry[]) => Entry[];
  /** Whether a list read back afterwards still holds the change. */
  holds: (list: Entry[]) => boolean;
};

/**
 * Read, change, and write the list, then read it back after `settle_ms`; if
 * another run's write undid the change, start over, up to `attempts` times.
 */
export async function changeAllowList(
  client: RenderClient,
  change: Change,
  options: { attempts?: number; settle_ms?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? 5;
  const settle_ms = options.settle_ms ?? 3000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const list = await call(client, "GET");
    const next = change.apply(list);
    if (JSON.stringify(next) !== JSON.stringify(list)) {
      await call(client, "PATCH", { ipAllowList: next });
    }
    await new Promise((resolve) => setTimeout(resolve, settle_ms));
    if (change.holds(await call(client, "GET"))) return;
  }
  throw new Error(
    `the allow list kept losing the change after ${attempts} attempts`
  );
}
