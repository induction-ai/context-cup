/**
 * Daytona sandbox listing and deletion, for sweeping up after a run.
 *
 * A sandbox holds its CPU, memory, and disk against the organization quota
 * until it is deleted, whatever its state. Only the harbor process that made
 * it deletes it, so a cancelled or crashed run leaves its sandboxes behind:
 * running ones until auto-stop, and ones whose build failed for good, since
 * auto-stop only acts on sandboxes that reached a running state.
 */
import { z } from "zod";

/** Stamped on every sandbox by `buildHarborCommand`. */
export const SUITE_LABEL = "context-cup-suite";
export const JOB_LABEL = "context-cup-job";

export const DAYTONA_API = "https://app.daytona.io/api";

const zSandbox = z.object({
  id: z.string(),
  state: z.string(),
  created_at: z.string(),
  cpu: z.number().nullish(),
  memory: z.number().nullish(),
  disk: z.number().nullish(),
  labels: z.record(z.string(), z.string()).nullish(),
});

const zPage = z.object({
  items: z.array(zSandbox),
  nextCursor: z.string().nullish(),
});

export type Sandbox = z.infer<typeof zSandbox>;

export type SandboxFilter = {
  /** Sandboxes carrying every one of these labels. */
  labels?: Record<string, string>;
  /** Sandboxes in this state, e.g. `error`. */
  state?: string;
};

export type DaytonaClient = {
  key: string;
  fetch?: typeof fetch;
  /** Pause between delete attempts that hit a state transition. */
  pauseMs?: number;
};

export function daytonaClient(env = process.env): DaytonaClient {
  const key = env.DAYTONA_API_KEY?.trim();
  if (!key) throw new Error("DAYTONA_API_KEY is not set");
  return { key };
}

function listQuery(filter: SandboxFilter, cursor?: string): string {
  const params = new URLSearchParams({ limit: "100" });
  if (filter.labels) params.set("labels", JSON.stringify(filter.labels));
  if (filter.state) params.set("states", filter.state);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** Every sandbox matching `filter`, across all pages. Daytona filters
 *  server-side, so an empty list means there are none. */
export async function listSandboxes(
  client: DaytonaClient,
  filter: SandboxFilter = {}
): Promise<Sandbox[]> {
  const get = client.fetch ?? fetch;
  const found: Sandbox[] = [];
  let cursor: string | undefined;
  do {
    const response = await get(
      `${DAYTONA_API}/sandbox?${listQuery(filter, cursor)}`,
      { headers: { Authorization: `Bearer ${client.key}` } }
    );
    if (!response.ok) {
      throw new Error(
        `Daytona list failed: ${response.status} ${await response.text()}`
      );
    }
    const page = zPage.parse(await response.json());
    found.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return found;
}

/** Daytona answers 409 while a sandbox changes state, which is where an
 *  exiting harbor leaves it; the transition takes seconds. */
const CONFLICT_ATTEMPTS = 3;

/** Deletes each sandbox, carrying on past failures so one stuck sandbox does
 *  not strand the rest. Returns why each failed one failed. */
export async function deleteSandboxes(
  client: DaytonaClient,
  ids: readonly string[]
): Promise<{ deleted: string[]; failed: Map<string, string> }> {
  const call = client.fetch ?? fetch;
  const pause = client.pauseMs ?? 2_000;
  const deleted: string[] = [];
  const failed = new Map<string, string>();
  for (const id of ids) {
    for (let attempt = 1; ; attempt++) {
      const response = await call(`${DAYTONA_API}/sandbox/${id}?force=true`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${client.key}` },
      });
      // 404: already gone, which is what the delete is for.
      if (response.ok || response.status === 404) {
        deleted.push(id);
        break;
      }
      if (response.status !== 409 || attempt === CONFLICT_ATTEMPTS) {
        failed.set(id, `${response.status} ${await response.text()}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return { deleted, failed };
}

/** Sandboxes created more than `hours` ago. */
export function olderThan(
  sandboxes: readonly Sandbox[],
  hours: number,
  now = new Date()
): Sandbox[] {
  const cutoff = now.getTime() - hours * 3_600_000;
  return sandboxes.filter((s) => Date.parse(s.created_at) < cutoff);
}

/** What a set of sandboxes holds against the organization quota: vCPU, GB of
 *  memory, and GB of disk. */
export function reserved(sandboxes: readonly Sandbox[]): {
  cpu: number;
  memory: number;
  disk: number;
} {
  return {
    cpu: sandboxes.reduce((n, s) => n + (s.cpu ?? 0), 0),
    memory: sandboxes.reduce((n, s) => n + (s.memory ?? 0), 0),
    disk: sandboxes.reduce((n, s) => n + (s.disk ?? 0), 0),
  };
}
