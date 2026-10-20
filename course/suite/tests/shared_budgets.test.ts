import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@context-cup/shared/test_helpers/index.js";
import { Pool } from "pg";
import {
  defaultHolder,
  HOLD_EXPIRY_MS,
  HOLD_TABLE,
  SharedBudgets,
  sharedBudgetsUrl,
  type LostHold,
} from "../src/shared_budgets.ts";

const database_url = process.env.DATABASE_URL!;
const db = new Pool({ connectionString: database_url });
const opened: SharedBudgets[] = [];
const quiet = () => {};

async function open(invocation_id: string, holder: string) {
  const budgets = await SharedBudgets.open({
    invocation_id,
    database_url,
    holder,
    report: quiet,
  });
  opened.push(budgets);
  return budgets;
}

async function rows(invocation_id?: string) {
  const result = await db.query<{
    budget_key: string;
    job_id: string;
    weight: number;
  }>(
    `SELECT budget_key, job_id, weight FROM ${HOLD_TABLE}
     WHERE $1::text IS NULL OR invocation_id = $1
     ORDER BY budget_key, job_id`,
    [invocation_id ?? null]
  );
  return result.rows;
}

/** Backdates an invocation's heartbeats past the expiry, as if the machine
 *  had been asleep. */
async function stopHeartbeats(invocation_id: string) {
  await db.query(
    `UPDATE ${HOLD_TABLE} SET heartbeat_at = now() - make_interval(secs => $2)
     WHERE invocation_id = $1`,
    [invocation_id, HOLD_EXPIRY_MS / 1000 + 1]
  );
}

const task_a = { key: "toolathlon/task:a", capacity: 1, weight: 1 };
const target = { key: "target:gpt", capacity: 4, weight: 2 };

describe("SharedBudgets", () => {
  beforeEach(async () => {
    await db.query(`DELETE FROM ${HOLD_TABLE}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const budgets of opened.splice(0)) await budgets.close();
  });

  afterAll(async () => {
    await db.end();
  });

  it("admits a job that fits and refuses one that would not, naming the holder", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");

    expect(await mine.acquire("j_a1", [task_a])).toEqual({ admitted: true });
    expect(await theirs.acquire("j_a2", [task_a])).toEqual({
      admitted: false,
      blocked: [
        {
          key: "toolathlon/task:a",
          capacity: 1,
          in_use: 1,
          holds: [
            {
              holder: "brian",
              invocation_id: "s_mine",
              job_id: "j_a1",
              weight: 1,
            },
          ],
        },
      ],
    });
    expect(await rows("s_theirs")).toEqual([]);
  });

  it("adds up weights from every machine against the capacity", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");

    expect(await mine.acquire("j1", [target])).toEqual({ admitted: true });
    expect(await theirs.acquire("j2", [target])).toEqual({ admitted: true });
    const third = await mine.acquire("j3", [target]);
    expect(third.admitted).toBe(false);
    expect(third).toMatchObject({ blocked: [{ in_use: 4, capacity: 4 }] });
  });

  it("never blocks on a budget without a cap, but holds it for runs that set one", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");
    const uncapped = { ...task_a, capacity: Infinity };

    expect(await mine.acquire("j1", [uncapped])).toEqual({ admitted: true });
    expect(await mine.acquire("j2", [uncapped])).toEqual({ admitted: true });
    const capped = await theirs.acquire("j3", [task_a]);
    expect(capped).toMatchObject({ admitted: false });
    expect(capped).toMatchObject({ blocked: [{ in_use: 2, capacity: 1 }] });
  });

  it("takes all of a job's claims or none", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");
    await theirs.acquire("j_other", [task_a]);

    const result = await mine.acquire("j_mine", [target, task_a]);
    expect(result.admitted).toBe(false);
    expect(await rows("s_mine")).toEqual([]);
  });

  it("frees a budget when the job releases it", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");
    await mine.acquire("j1", [task_a]);
    await mine.release("j1");

    expect(await theirs.acquire("j2", [task_a])).toEqual({ admitted: true });
    expect(await rows()).toEqual([
      { budget_key: "toolathlon/task:a", job_id: "j2", weight: 1 },
    ]);
  });

  it("stops counting a hold whose owner stopped asserting it", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");
    await mine.acquire("j1", [task_a]);
    await stopHeartbeats("s_mine");

    expect(await theirs.acquire("j2", [task_a])).toEqual({ admitted: true });
  });

  it("refreshes a live hold without re-checking it against this run's capacity", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");
    await mine.acquire("j1", [task_a]);
    // The other run's suite file leaves the task unlimited, so it gets in.
    expect(
      await theirs.acquire("j2", [{ ...task_a, capacity: Infinity }])
    ).toEqual({ admitted: true });

    const lost = vi.fn();
    mine.on_lost = lost;
    await mine.heartbeat();
    expect(lost).not.toHaveBeenCalled();
    expect(await rows("s_mine")).toEqual([
      { budget_key: "toolathlon/task:a", job_id: "j1", weight: 1 },
    ]);
  });

  it("lets a hold whose release failed expire instead of refreshing it", async () => {
    const mine = await open("s_mine", "brian");
    await mine.acquire("j1", [task_a]);
    vi.spyOn(
      mine as unknown as { deleteHolds: () => Promise<void> },
      "deleteHolds"
    ).mockRejectedValueOnce(new Error("connection terminated"));
    await expect(mine.release("j1")).rejects.toThrow("connection terminated");
    await stopHeartbeats("s_mine");

    await mine.heartbeat();
    expect(await rows("s_mine")).toEqual([]);
  });

  it("leaves nothing behind when a release overlaps a heartbeat", async () => {
    const mine = await open("s_mine", "brian");
    await mine.acquire("j1", [task_a]);
    await db.query(`DELETE FROM ${HOLD_TABLE}`);

    const beat = mine.heartbeat();
    const released = mine.release("j1");
    await beat;
    await released;
    expect(await rows("s_mine")).toEqual([]);
  });

  it("takes again a hold that was swept while the budget stayed free", async () => {
    const mine = await open("s_mine", "brian");
    await mine.acquire("j1", [task_a, target]);
    await db.query(`DELETE FROM ${HOLD_TABLE}`);

    const lost = vi.fn();
    mine.on_lost = lost;
    await mine.heartbeat();
    expect(lost).not.toHaveBeenCalled();
    expect(await rows("s_mine")).toEqual([
      { budget_key: "target:gpt", job_id: "j1", weight: 2 },
      { budget_key: "toolathlon/task:a", job_id: "j1", weight: 1 },
    ]);
  });

  it("loses a hold another machine took while this one was unreachable", async () => {
    const mine = await open("s_mine", "brian");
    const theirs = await open("s_theirs", "alice");
    await mine.acquire("j1", [task_a, target]);
    await stopHeartbeats("s_mine");
    expect(await theirs.acquire("j2", [task_a])).toEqual({ admitted: true });

    const lost: LostHold[] = [];
    mine.on_lost = (hold) => lost.push(hold);
    await mine.heartbeat();
    expect(lost).toEqual([
      {
        job_id: "j1",
        blocked: [
          {
            key: "toolathlon/task:a",
            capacity: 1,
            in_use: 1,
            holds: [
              {
                holder: "alice",
                invocation_id: "s_theirs",
                job_id: "j2",
                weight: 1,
              },
            ],
          },
        ],
      },
    ]);
    expect(await rows("s_mine")).toEqual([]);
    // Once lost, the heartbeat no longer tries to take the budget back.
    await mine.heartbeat();
    expect(await rows("s_mine")).toEqual([]);
  });

  it("drops every hold when closed", async () => {
    const mine = await open("s_mine", "brian");
    await mine.acquire("j1", [task_a]);
    await mine.acquire("j2", [target]);
    await opened.pop()!.close();

    expect(await rows()).toEqual([]);
  });

  it("refuses to open when the database is unreachable", async () => {
    await expect(
      SharedBudgets.open({
        invocation_id: "s_offline",
        database_url: "postgres://localhost:1/nowhere",
      })
    ).rejects.toThrow(/shared budgets unavailable at localhost:1\/nowhere/);
  });

  it("refuses to open a database that has not been migrated", async () => {
    const url = new URL(database_url);
    url.pathname = "/postgres";
    await expect(
      SharedBudgets.open({ invocation_id: "s_bare", database_url: url.href })
    ).rejects.toThrow(/no suite_budget_hold table; run bin\/db migrate/);
  });
});

describe("sharedBudgetsUrl", () => {
  it("prefers SUITE_DATABASE_URL and falls back to the results database", () => {
    expect(
      sharedBudgetsUrl({
        SUITE_DATABASE_URL: "postgres://suite",
        DATABASE_URL: "postgres://results",
      })
    ).toBe("postgres://suite");
    expect(
      sharedBudgetsUrl({
        SUITE_DATABASE_URL: " ",
        DATABASE_URL: "postgres://results",
      })
    ).toBe("postgres://results");
  });

  it("refuses to run without either url", () => {
    expect(() => sharedBudgetsUrl({})).toThrow(/SUITE_DATABASE_URL/);
  });
});

describe("defaultHolder", () => {
  it("names the GitHub run in CI, else the invocation, never a user or host", () => {
    expect(defaultHolder("s_1/abc", { GITHUB_RUN_ID: "123" })).toBe(
      "github run 123"
    );
    expect(defaultHolder("s_1/abc", {})).toBe("local run s_1/abc");
  });
});
