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

const sandbox = (id: string, created_at = "2026-09-01T00:00:00Z"): Sandbox => ({
  id,
  state: "started",
  created_at,
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

  it("deletes, retrying a state transition and counting 404 as gone", async () => {
    const { fetch, calls } = fakeFetch([
      new Response("busy", { status: 409 }),
      new Response(null, { status: 200 }),
      new Response("gone", { status: 404 }),
      new Response("boom", { status: 500 }),
    ]);
    const outcome = await deleteSandboxes({ key: "k", fetch, pauseMs: 0 }, [
      "a",
      "b",
      "c",
    ]);
    expect(outcome.deleted).toEqual(["a", "b"]);
    expect([...outcome.failed]).toEqual([["c", "500 boom"]]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", `${DAYTONA_API}/sandbox/a?force=true`],
      ["DELETE", `${DAYTONA_API}/sandbox/a?force=true`],
      ["DELETE", `${DAYTONA_API}/sandbox/b?force=true`],
      ["DELETE", `${DAYTONA_API}/sandbox/c?force=true`],
    ]);
  });

  it("gives up on a sandbox that stays in transition", async () => {
    const { fetch } = fakeFetch([
      new Response("busy", { status: 409 }),
      new Response("busy", { status: 409 }),
      new Response("busy", { status: 409 }),
    ]);
    const outcome = await deleteSandboxes({ key: "k", fetch, pauseMs: 0 }, [
      "a",
    ]);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed.get("a")).toBe("409 busy");
  });

  it("keeps sandboxes older than the cutoff", async () => {
    const now = new Date("2026-09-02T00:00:00Z");
    const old = sandbox("old", "2026-09-01T00:00:00Z");
    const young = sandbox("young", "2026-09-01T20:00:00Z");
    expect(olderThan([old, young], 12, now).map((s) => s.id)).toEqual(["old"]);
  });
});
