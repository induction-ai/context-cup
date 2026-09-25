"use client";

import { Children, useId, useState, type ReactNode } from "react";

/** Bootstrap `nav-tabs` over server-rendered panes: one label per child,
 *  only the chosen pane shown. */
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
  const id = useId();
  const panes = Children.toArray(children);
  return (
    <>
      <ul className={`nav nav-tabs ${className ?? ""}`} role="tablist">
        {labels.map((label, i) => (
          <li className="nav-item" key={label} role="presentation">
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
