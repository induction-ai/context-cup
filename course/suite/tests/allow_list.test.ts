import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  changeAllowList,
  hasRun,
  RENDER_API,
  renderClient,
  runEntry,
  withoutRun,
  type Entry,
} from "../src/allow_list.ts";

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A fetch that answers each GET with the next list in `reads` and each PATCH
 *  with what it was sent, recording every call. */
function fakeRender(reads: Entry[][]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url: String(input),
      method,
      auth: new Headers(init?.headers).get("Authorization"),
      body,
    });
    if (method === "PATCH") return Response.json(body);
    const list = reads.shift();
    if (!list) throw new Error(`unexpected read of ${String(input)}`);
    return Response.json({ id: "pg", ipAllowList: list });
  };
  return { fetch: impl as typeof fetch, calls };
}

const now = new Date("2026-11-11T12:00:00Z");
const maintainer: Entry = {
  cidrBlock: "198.51.100.7/32",
  description: "office",
};
const other = runEntry("41.1", "203.0.113.2", now);
const lapsed = runEntry(
  "40.1",
  "203.0.113.3",
  new Date("2026-11-11T04:00:00Z")
);
const mine = runEntry("42.1", "203.0.113.1", now);

const open = {
  apply: (list: Entry[]) => [...withoutRun(list, "42.1", now), mine],
  holds: (list: Entry[]) => hasRun(list, "42.1"),
};
const close = {
  apply: (list: Entry[]) => withoutRun(list, "42.1", now),
  holds: (list: Entry[]) => !hasRun(list, "42.1"),
};
const fast = { settle_ms: 0 };

describe("database allow list", () => {
  it("needs RENDER_API_KEY and RENDER_POSTGRES_ID", async () => {
    expect(() => renderClient({ RENDER_POSTGRES_ID: "pg" })).toThrow(
      "RENDER_API_KEY is not set"
    );
    expect(() => renderClient({ RENDER_API_KEY: "k" })).toThrow(
      "RENDER_POSTGRES_ID is not set"
    );
  });

  it("lets a run's runner in until an hour past the job limit", async () => {
    expect(mine).toEqual({
      cidrBlock: "203.0.113.1/32",
      description: "suite run 42.1 until 2026-11-11T19:00:00.000Z",
    });
  });

  it("opens by adding the run's entry to everything already allowed", async () => {
    const { fetch, calls } = fakeRender([
      [maintainer, other],
      [maintainer, other, mine],
    ]);
    await changeAllowList({ key: "k", postgres_id: "pg", fetch }, open, fast);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(calls[1]).toEqual({
      url: `${RENDER_API}/postgres/pg`,
      method: "PATCH",
      auth: "Bearer k",
      body: { ipAllowList: [maintainer, other, mine] },
    });
  });

  it("drops entries whose runs have lapsed", async () => {
    const { fetch, calls } = fakeRender([
      [lapsed, maintainer],
      [maintainer, mine],
    ]);
    await changeAllowList({ key: "k", postgres_id: "pg", fetch }, open, fast);
    expect(calls[1]!.body).toEqual({ ipAllowList: [maintainer, mine] });
  });

  it("closes by removing only the run's entry", async () => {
    const { fetch, calls } = fakeRender([
      [maintainer, mine, other],
      [maintainer, other],
    ]);
    await changeAllowList({ key: "k", postgres_id: "pg", fetch }, close, fast);
    expect(calls[1]!.body).toEqual({ ipAllowList: [maintainer, other] });
  });

  it("writes nothing when closing a run that never opened", async () => {
    const { fetch, calls } = fakeRender([[maintainer], [maintainer]]);
    await changeAllowList({ key: "k", postgres_id: "pg", fetch }, close, fast);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("tries again when another run's write drops the entry", async () => {
    const { fetch, calls } = fakeRender([
      [other],
      [other],
      [other],
      [other, mine],
    ]);
    await changeAllowList({ key: "k", postgres_id: "pg", fetch }, open, fast);
    expect(calls.map((c) => c.method)).toEqual([
      "GET",
      "PATCH",
      "GET",
      "GET",
      "PATCH",
      "GET",
    ]);
  });

  it("gives up when the entry keeps being dropped", async () => {
    const { fetch } = fakeRender([[], [], [], []]);
    await expect(
      changeAllowList({ key: "k", postgres_id: "pg", fetch }, open, {
        ...fast,
        attempts: 2,
      })
    ).rejects.toThrow("after 2 attempts");
  });

  it("reports what Render answered when a call fails", async () => {
    const fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof globalThis.fetch;
    await expect(
      changeAllowList({ key: "k", postgres_id: "pg", fetch }, open, fast)
    ).rejects.toThrow("Render GET postgres: 401 unauthorized");
  });
});
