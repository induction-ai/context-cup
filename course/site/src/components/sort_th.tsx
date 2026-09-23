import { sortHref, sortLabel, type Dir, type Sort } from "@/src/lib/sort";

/** A table header cell that links to the page sorted by its column. */
export function SortTh<K extends string>({
  path,
  current,
  column,
  label,
  numeric,
  firstDir,
}: {
  path: string;
  current: Sort<K>;
  column: K;
  label: string;
  /** Numeric columns are right-aligned and start descending; names start
   *  ascending. `firstDir` overrides the direction alone. */
  numeric?: boolean;
  firstDir?: Dir;
}) {
  const first: Dir = firstDir ?? (numeric ? "desc" : "asc");
  return (
    <th className={numeric ? "text-end font-monospace" : undefined}>
      <a
        className="link-body-emphasis text-decoration-none"
        href={sortHref(path, current, column, first)}
      >
        {sortLabel(label, current, column)}
      </a>
    </th>
  );
}
