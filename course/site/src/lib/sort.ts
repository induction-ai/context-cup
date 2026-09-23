/** Table sorting driven by the URL (`?sort=<key>&dir=asc|desc`), so pages
 *  stay server-rendered and a sorted view is a link. */

export type Dir = "asc" | "desc";
export type Sort<K extends string> = { key: K; dir: Dir };

type Params = Record<string, string | string[] | undefined>;

/** The sort a request asked for, or the default when absent or unknown. */
export function parseSort<K extends string>(
  params: Params,
  keys: readonly K[],
  fallback: Sort<K>
): Sort<K> {
  const rawKey = Array.isArray(params.sort) ? params.sort[0] : params.sort;
  const rawDir = Array.isArray(params.dir) ? params.dir[0] : params.dir;
  const key = keys.find((k) => k === rawKey);
  if (!key) return fallback;
  const dir: Dir =
    rawDir === "desc"
      ? "desc"
      : rawDir === "asc"
        ? "asc"
        : fallback.key === key
          ? fallback.dir
          : "asc";
  return { key, dir };
}

/** Rows ordered by `sort`. Nulls sort last in either direction; ties keep
 *  their incoming order. */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: Sort<K>,
  value: (row: T, key: K) => string | number | Date | null | undefined
): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row, sort.key) }))
    .sort((a, b) => {
      const av = norm(a.v);
      const bv = norm(b.v);
      if (av === null && bv === null) return a.index - b.index;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv)
          : av < bv
            ? -1
            : av > bv
              ? 1
              : 0;
      return cmp === 0 ? a.index - b.index : cmp * sign;
    })
    .map((x) => x.row);
}

function norm(
  v: string | number | Date | null | undefined
): string | number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return v;
}

/** The href that sorts by `key`: same column flips the direction, a new
 *  column starts with `firstDir` (descending for numbers, ascending for
 *  names). */
export function sortHref<K extends string>(
  path: string,
  current: Sort<K>,
  key: K,
  firstDir: Dir
): string {
  const dir: Dir =
    current.key === key ? (current.dir === "asc" ? "desc" : "asc") : firstDir;
  return `${path}?sort=${encodeURIComponent(key)}&dir=${dir}`;
}

/** The header cell text with a direction marker on the active column. */
export function sortLabel<K extends string>(
  label: string,
  current: Sort<K>,
  key: K
): string {
  if (current.key !== key) return label;
  return `${label} ${current.dir === "asc" ? "▲" : "▼"}`;
}

export type Page = { page: number; per: number };

/** The page a request asked for: `?page=N&per=M`, 1-based, clamped. */
export function parsePage(
  params: Params,
  defaults: Page = { page: 1, per: 50 },
  maxPer = 200
): Page {
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const page = Math.max(
    1,
    Math.floor(Number(one(params.page)) || defaults.page)
  );
  const per = Math.min(
    maxPer,
    Math.max(1, Math.floor(Number(one(params.per)) || defaults.per))
  );
  return { page, per };
}

/** The href for another page of the same sorted view. */
export function pageHref<K extends string>(
  path: string,
  sort: Sort<K>,
  page: Page,
  target: number
): string {
  return `${path}?sort=${encodeURIComponent(sort.key)}&dir=${sort.dir}&page=${target}&per=${page.per}`;
}
