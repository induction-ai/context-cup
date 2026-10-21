import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  DAYTONA_API,
  daytonaClient,
  deleteSandboxes,
  listSandboxes,
  olderThan,
  pending,
  SUITE_LABEL,
  type Sandbox,
} from "../src/daytona.ts";

type Call = { url: string; method: string; auth: string | null };

/** A fetch that answers from `responses` in order and records each call. */
function fakeFetch(responses: Response[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call to ${String(input)}`);
    return next;
  };
  return { fetch: impl as typeof fetch, calls };
}

const sandbox = (id: string, createdAt = "2026-09-01T00:00:00Z"): Sandbox => ({
  id,
  state: "started",
  createdAt,
  labels: { [SUITE_LABEL]: "s_abc" },
});

describe("daytona", () => {
  it("needs DAYTONA_API_KEY", async () => {
    expect(() => daytonaClient({})).toThrow("DAYTONA_API_KEY is not set");
    expect(daytonaClient({ DAYTONA_API_KEY: " k " }).key).toBe("k");
  });

  it("lists by label across pages", async () => {
    const { fetch, calls } = fakeFetch([
      Response.json({ items: [sandbox("a")], nextCursor: "c2" }),
      Response.json({ items: [sandbox("b")], nextCursor: null }),
    ]);
    const found = await listSandboxes(
      { key: "k", fetch },
      { labels: { [SUITE_LABEL]: "s_abc" } }
    );
    expect(found.map((s) => s.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.origin + first.pathname).toBe(`${DAYTONA_API}/sandbox`);
    expect(JSON.parse(first.searchParams.get("labels")!)).toEqual({
      [SUITE_LABEL]: "s_abc",
    });
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
    expect(calls[0]!.auth).toBe("Bearer k");
  });

  it("fails loudly when listing fails", async () => {
    const { fetch } = fakeFetch([new Response("nope", { status: 401 })]);
    await expect(listSandboxes({ key: "k", fetch })).rejects.toThrow(
      "Daytona list failed: 401 nope"
    );
  });

  it("deletes, counting 404 as gone and 409 as already deleting", async () => {
    const { fetch, calls } = fakeFetch([
      new Response(null, { status: 200 }),
      new Response("gone", { status: 404 }),
      new Response("busy", { status: 409 }),
      new Response("boom", { status: 500 }),
    ]);
    const outcome = await deleteSandboxes({ key: "k", fetch }, [
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(outcome.deleted).toEqual(["a", "b"]);
    expect(outcome.alreadyDeleting).toEqual(["c"]);
    expect([...outcome.failed]).toEqual([["d", "500 boom"]]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", `${DAYTONA_API}/sandbox/a?force=true`],
      ["DELETE", `${DAYTONA_API}/sandbox/b?force=true`],
      ["DELETE", `${DAYTONA_API}/sandbox/c?force=true`],
      ["DELETE", `${DAYTONA_API}/sandbox/d?force=true`],
    ]);
  });

  it("sets aside sandboxes Daytona is already destroying", async () => {
    const started = sandbox("started");
    const stopping = { ...sandbox("stopping"), state: "stopping" };
    // Harbor's own delete leaves a sandbox like this; it has sat there for
    // hours, answering every further delete with 409.
    const destroying = {
      ...sandbox("destroying"),
      state: "destroying",
      desiredState: "destroyed",
    };
    const marked = { ...sandbox("marked"), desiredState: "destroyed" };
    // A destroy that failed leaves the sandbox in error, still marked.
    const failed = { ...marked, id: "failed", state: "error" };
    const { toDelete, alreadyDestroying } = pending([
      started,
      stopping,
      destroying,
      marked,
      failed,
    ]);
    expect(toDelete.map((s) => s.id)).toEqual([
      "started",
      "stopping",
      "failed",
    ]);
    expect(alreadyDestroying.map((s) => s.id)).toEqual([
      "destroying",
      "marked",
    ]);
  });

  it("keeps sandboxes older than the cutoff", async () => {
    const now = new Date("2026-09-02T00:00:00Z");
    const old = sandbox("old", "2026-09-01T00:00:00Z");
    const young = sandbox("young", "2026-09-01T20:00:00Z");
    const undated = { ...sandbox("undated"), createdAt: undefined };
    expect(olderThan([old, young, undated], 12, now).map((s) => s.id)).toEqual([
      "old",
    ]);
  });
});
