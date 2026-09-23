import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  pageHref,
  parsePage,
  parseSort,
  sortHref,
  sortLabel,
  sortRows,
} from "../src/lib/sort";

const KEYS = ["name", "cost"] as const;

describe("parseSort", () => {
  it("falls back when the key is missing or unknown", () => {
    const fallback = { key: "name" as const, dir: "asc" as const };
    expect(parseSort({}, KEYS, fallback)).toEqual(fallback);
    expect(parseSort({ sort: "nope" }, KEYS, fallback)).toEqual(fallback);
    expect(parseSort({ sort: "cost", dir: "desc" }, KEYS, fallback)).toEqual({
      key: "cost",
      dir: "desc",
    });
    expect(parseSort({ sort: ["cost"], dir: "junk" }, KEYS, fallback)).toEqual({
      key: "cost",
      dir: "asc",
    });
  });
});

describe("sortRows", () => {
  const rows = [
    { name: "b", cost: 3 },
    { name: "a", cost: null },
    { name: "c", cost: 1 },
    { name: "d", cost: 3 },
  ];
  const value = (r: (typeof rows)[number], k: "name" | "cost") => r[k];

  it("orders by number either way with nulls last and stable ties", () => {
    expect(
      sortRows(rows, { key: "cost", dir: "asc" }, value).map((r) => r.name)
    ).toEqual(["c", "b", "d", "a"]);
    expect(
      sortRows(rows, { key: "cost", dir: "desc" }, value).map((r) => r.name)
    ).toEqual(["b", "d", "c", "a"]);
  });

  it("orders strings and leaves the input untouched", () => {
    expect(
      sortRows(rows, { key: "name", dir: "desc" }, value).map((r) => r.name)
    ).toEqual(["d", "c", "b", "a"]);
    expect(rows[0]!.name).toBe("b");
  });
});

describe("header helpers", () => {
  it("flips the active column and starts a new one in its natural direction", () => {
    const current = { key: "cost" as const, dir: "desc" as const };
    expect(sortHref("/suites/x", current, "cost", "desc")).toBe(
      "/suites/x?sort=cost&dir=asc"
    );
    expect(sortHref("/suites/x", current, "name", "asc")).toBe(
      "/suites/x?sort=name&dir=asc"
    );
    expect(sortLabel("cost", current, "cost")).toBe("cost ▼");
    expect(sortLabel("name", current, "name")).toBe("name");
  });
});

describe("paging", () => {
  it("parses and clamps page and per", () => {
    expect(parsePage({})).toEqual({ page: 1, per: 50 });
    expect(parsePage({ page: "3", per: "20" })).toEqual({ page: 3, per: 20 });
    expect(parsePage({ page: "0", per: "9999" })).toEqual({
      page: 1,
      per: 200,
    });
    expect(parsePage({ page: "x", per: "-4" })).toEqual({ page: 1, per: 1 });
  });

  it("keeps the sort in page links", () => {
    expect(
      pageHref("/suites", { key: "cost", dir: "desc" }, { page: 2, per: 50 }, 3)
    ).toBe("/suites?sort=cost&dir=desc&page=3&per=50");
  });
});
