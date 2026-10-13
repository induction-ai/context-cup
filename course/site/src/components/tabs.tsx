"use client";

import {
  Children,
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Where a list of tabs breaks into rows when it does not fit on one: the
 *  fewest rows that fit, with the tabs spread so the widest row is as
 *  narrow as it can be, rather than a full row and a leftover. Returns the
 *  indices that start a new row. */
export function rowBreaks(widths: number[], available: number): number[] {
  // The fewest rows a left-to-right fill needs.
  let rows = 1;
  let used = 0;
  for (const w of widths) {
    if (used > 0 && used + w > available) {
      rows++;
      used = 0;
    }
    used += w;
  }
  if (rows === 1) return [];
  // Split into exactly that many runs, minimising the widest: the classic
  // linear partition, small enough here to do plainly.
  const n = widths.length;
  const prefix = [0];
  for (const w of widths) prefix.push(prefix[prefix.length - 1]! + w);
  const sum = (i: number, j: number) => prefix[j]! - prefix[i]!;
  // best[k][j]: the narrowest widest-run splitting the first j tabs into k.
  const best: number[][] = Array.from({ length: rows + 1 }, () =>
    Array<number>(n + 1).fill(Infinity)
  );
  const cut: number[][] = Array.from({ length: rows + 1 }, () =>
    Array<number>(n + 1).fill(0)
  );
  for (let j = 1; j <= n; j++) best[1]![j] = sum(0, j);
  for (let k = 2; k <= rows; k++) {
    for (let j = k; j <= n; j++) {
      for (let i = k - 1; i < j; i++) {
        const widest = Math.max(best[k - 1]![i]!, sum(i, j));
        // A tie goes to the later cut: the upper row is the fuller one.
        if (widest <= best[k]![j]!) {
          best[k]![j] = widest;
          cut[k]![j] = i;
        }
      }
    }
  }
  const breaks: number[] = [];
  let j = n;
  for (let k = rows; k > 1; k--) {
    j = cut[k]![j]!;
    breaks.unshift(j);
  }
  return breaks;
}

/** Bootstrap `nav-tabs` over server-rendered panes: one label per child,
 *  only the chosen pane shown. When the tabs need more than one row they
 *  are spread evenly across the rows (see {@link rowBreaks}), re-done as
 *  the width changes. */
export function Tabs({
  labels,
  className,
  children,
}: {
  labels: string[];
  className?: string;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState(0);
  const [breaks, setBreaks] = useState<number[]>([]);
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const panes = Children.toArray(children);

  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const measure = () => {
      const style = getComputedStyle(ul);
      const available =
        ul.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      const widths = Array.from(
        ul.querySelectorAll<HTMLElement>("li[data-tab]"),
        (li) => li.offsetWidth
      );
      const next = rowBreaks(widths, available);
      // The observer fires on every resize; the breaks rarely change.
      setBreaks((prev) =>
        prev.length === next.length && prev.every((b, i) => b === next[i])
          ? prev
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ul);
    return () => observer.disconnect();
  }, [labels]);

  return (
    <>
      <ul
        className={`nav nav-tabs ${className ?? ""}`}
        role="tablist"
        ref={list}
      >
        {labels.map((label, i) => (
          <Fragment key={i}>
            {breaks.includes(i) && <li className="w-100" aria-hidden />}
            <li className="nav-item" role="presentation" data-tab>
              <button
                type="button"
                role="tab"
                id={`${id}-tab-${i}`}
                aria-controls={`${id}-pane-${i}`}
                aria-selected={i === chosen}
                className={`nav-link font-monospace${i === chosen ? " active" : ""}`}
                onClick={() => setChosen(i)}
              >
                {label}
              </button>
            </li>
          </Fragment>
        ))}
      </ul>
      {panes.map((pane, i) => (
        <div
          key={i}
          role="tabpanel"
          id={`${id}-pane-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== chosen}
        >
          {pane}
        </div>
      ))}
    </>
  );
}
