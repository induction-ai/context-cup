"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

/** The key the baseline's dot and row share; drivers use their names. */
export const BASELINE_KEY = " baseline";

type Focus = {
  hovered: string | null;
  pinned: string | null;
  setHovered: Dispatch<SetStateAction<string | null>>;
  setPinned: Dispatch<SetStateAction<string | null>>;
};

const FocusContext = createContext<Focus | null>(null);

/** Which driver a leaderboard's chart and table are pointing at, shared so
 *  hovering a row is hovering its dot, and the other way round. */
export function BoardFocus({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  return (
    <FocusContext.Provider value={{ hovered, pinned, setHovered, setPinned }}>
      {children}
    </FocusContext.Provider>
  );
}

export function useBoardFocus(): Focus {
  const focus = useContext(FocusContext);
  if (!focus) throw new Error("useBoardFocus needs a BoardFocus around it");
  return focus;
}

/** A table row that points at its dot while the pointer is on it, and is
 *  highlighted while its dot is hovered or pinned. */
export function FocusRow({
  focusKey,
  className,
  children,
}: {
  focusKey: string;
  className?: string;
  children: ReactNode;
}) {
  const { hovered, pinned, setHovered } = useBoardFocus();
  const active = (hovered ?? pinned) === focusKey;
  const classes = [className, active && !className ? "table-active" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <tr
      className={classes || undefined}
      onMouseEnter={() => setHovered(focusKey)}
      onMouseLeave={() => setHovered(null)}
    >
      {children}
    </tr>
  );
}
