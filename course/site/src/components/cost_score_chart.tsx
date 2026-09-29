"use client";

import { logScale, scoreScale } from "@/src/lib/chart";
import { dollars, reward } from "@/src/lib/format";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { BASELINE_KEY, useBoardFocus } from "./board_focus";

const W = 760;
const H = 420;
const M = { top: 16, right: 20, bottom: 52, left: 60 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;
/** Dots at the edge of the domain (a perfect score) stay inside the plot. */
const INSET = 14;

const QUALIFIES = "var(--bs-primary)";
const BASELINE = "var(--bs-emphasis-color)";
const OTHER = "var(--bs-gray-600)";
const MUTED = "var(--bs-secondary-color)";
const GRID = "var(--bs-border-color-translucent)";

/** One dot, as the page works it out: a driver, or the baseline. */
export type ChartDot = {
  key: string;
  name: string;
  /** Cost: dollars per full benchmark run, or a ratio to the baselines'. */
  x: number;
  /** Score, or a ratio to the baselines'. */
  y: number;
  kind: "leader" | "qualifies" | "other";
  /** What screen readers say. */
  note: string;
  /** The tooltip's lines under the name: a label and its value. */
  lines: [string, string][];
};

/** What the axes measure: one benchmark's score against the dollars of a
 *  full run, or the combined board's ratios to the baselines. */
export type ChartScale = "run" | "ratio";

const AXES: Record<
  ChartScale,
  {
    x: string;
    y: string;
    xTick: (v: number) => string;
    yTick: (v: number) => string;
    bar: (v: number) => string;
    budget: (v: number) => string;
    aria: string;
    /** Why a driver has no dot. */
    lacks: string;
  }
> = {
  run: {
    x: "$ per full benchmark run (log)",
    y: "Score",
    xTick: (v) => `$${v}`,
    yTick: (v) => `${Math.round(v * 100)}%`,
    bar: (v) => `baseline score ${reward(v)}`,
    budget: (v) => `baseline cost ${dollars(v * 100)}`,
    aria: "Score against dollars per full benchmark run, one dot per driver",
    lacks: "no score or cost yet",
  },
  ratio: {
    x: "cost vs the baselines, geometric mean (log)",
    y: "Worse score vs baseline",
    xTick: (v) => `${v}×`,
    yTick: (v) => `${v.toFixed(1)}×`,
    bar: () => "baseline scores",
    budget: () => "baseline costs",
    aria: "Worse score ratio against the geometric mean of cost ratios, one dot per driver",
    lacks: "no scored run of every benchmark yet",
  },
};

/** One marker, placed. */
type Point = ChartDot & {
  color: string;
  big: boolean;
  labelled: boolean;
  /** Which side its name prefers. The leader is always cheaper than the
   *  baseline, so its name goes left and the baseline's right. */
  side: -1 | 1;
};

/** Score against cost (log), one dot per driver and one for the baseline.
 *  The shaded corner is at or above the baseline's score and left of its
 *  cost, where a driver qualifies (on the combined board, roughly: a
 *  qualifier must be under budget on each benchmark, so the colours are
 *  the word).
 *
 *  Hovering (or focusing) a dot shows its score and cost; clicking it pins
 *  that tooltip until a click elsewhere, Escape, or a second click on the
 *  dot. Hovering another dot while one is pinned shows that one for as long
 *  as the pointer stays on it. Hovering a driver's table row does the same
 *  (`BoardFocus` shares the state). */
export function CostScoreChart({
  dots,
  baseline,
  unplotted,
  scale,
}: {
  dots: ChartDot[];
  baseline: ChartDot | null;
  /** Drivers left off for want of a score or cost. */
  unplotted: number;
  scale: ChartScale;
}) {
  const { hovered, pinned, setHovered, setPinned } = useBoardFocus();
  const frame = useRef<HTMLDivElement>(null);

  // A pinned tooltip closes on a press outside the chart or on Escape.
  useEffect(() => {
    if (pinned === null) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !frame.current?.contains(event.target)
      ) {
        setPinned(null);
      }
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(null);
        setHovered(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [pinned, setHovered, setPinned]);

  const axes = AXES[scale];
  const drivers = dots.filter((d) => d.x > 0 && Number.isFinite(d.x));
  // A few dots are all named; a crowd names only the leader and baseline.
  const few = drivers.length <= 6;
  const points: Point[] = drivers.map((d) => ({
    ...d,
    color: d.kind === "other" ? OTHER : QUALIFIES,
    big: d.kind === "leader",
    labelled: few || d.kind === "leader",
    side: d.kind === "leader" ? -1 : 1,
  }));
  if (baseline) {
    points.push({
      ...baseline,
      color: BASELINE,
      big: false,
      labelled: true,
      side: 1,
    });
  }
  if (drivers.length === 0 && !baseline) return null;
  const bar = baseline ? baseline.y : null;
  const budgetRun = baseline ? baseline.x : null;
  const x = logScale(points.map((p) => p.x));
  const y = scoreScale(
    points.map((p) => p.y),
    scale === "ratio" ? Infinity : 1
  );
  const px = (v: number) => M.left + INSET + x.at(v) * (PW - 2 * INSET);
  const py = (v: number) => M.top + INSET + (1 - y.at(v)) * (PH - 2 * INSET);
  const barY = bar != null ? py(Math.max(bar, y.domain[0])) : null;
  const budgetX =
    budgetRun != null && budgetRun > 0
      ? px(Math.min(budgetRun, x.domain[1]))
      : null;
  // Labelled dots draw last so their labels sit on top.
  const ordered = [...points].sort(
    (a, b) => Number(a.labelled) - Number(b.labelled)
  );
  const missing = unplotted + dots.length - drivers.length;
  const activeKey = hovered ?? pinned;
  const active = points.find((p) => p.key === activeKey);
  const togglePin = (key: string) =>
    setPinned((current) => (current === key ? null : key));

  return (
    <figure className="mb-0">
      {bar != null && (
        <div className="d-flex flex-wrap gap-3 small mb-2" aria-hidden="true">
          <Key color={QUALIFIES} label="Qualifies" />
          <Key color={BASELINE} label="Baseline" />
          <Key color={OTHER} label="Doesn’t qualify" />
        </div>
      )}
      <div
        ref={frame}
        className="position-relative"
        style={{ maxWidth: W }}
        onClick={() => setPinned(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ height: "auto", display: "block" }}
          role="img"
          aria-label={axes.aria}
          fontSize={12}
        >
          {barY != null && budgetX != null && budgetX > M.left && (
            <rect
              x={M.left}
              y={M.top}
              width={budgetX - M.left}
              height={barY - M.top}
              fill={QUALIFIES}
              fillOpacity={0.07}
            />
          )}
          {y.ticks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={M.left}
                x2={M.left + PW}
                y1={py(t)}
                y2={py(t)}
                stroke={GRID}
              />
              <text
                x={M.left - 8}
                y={py(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fill={MUTED}
                className="font-monospace"
              >
                {axes.yTick(t)}
              </text>
            </g>
          ))}
          {x.ticks.map((t) => (
            <g key={`x${t}`}>
              <line
                x1={px(t)}
                x2={px(t)}
                y1={M.top}
                y2={M.top + PH}
                stroke={GRID}
              />
              <text
                x={px(t)}
                y={M.top + PH + 18}
                textAnchor="middle"
                fill={MUTED}
                className="font-monospace"
              >
                {axes.xTick(t)}
              </text>
            </g>
          ))}
          {bar != null && barY != null && (
            <g>
              <line
                x1={M.left}
                x2={M.left + PW}
                y1={barY}
                y2={barY}
                stroke={MUTED}
                strokeDasharray="4 4"
              />
              <text
                x={M.left + PW - 4}
                y={barY - 6}
                textAnchor="end"
                fill={MUTED}
              >
                {axes.bar(bar)}
              </text>
            </g>
          )}
          {budgetX != null && (
            <g>
              <line
                x1={budgetX}
                x2={budgetX}
                y1={M.top}
                y2={M.top + PH}
                stroke={MUTED}
                strokeDasharray="4 4"
              />
              <text x={budgetX + 6} y={M.top + PH - 6} fill={MUTED}>
                {axes.budget(budgetRun!)}
              </text>
            </g>
          )}
          <line
            x1={M.left}
            x2={M.left + PW}
            y1={M.top + PH}
            y2={M.top + PH}
            stroke="var(--bs-border-color)"
          />
          {ordered.map((p) => {
            const cx = px(p.x);
            const cy = py(p.y);
            const dimmed = active != null && active.key !== p.key;
            return (
              <g key={p.key} opacity={dimmed ? 0.35 : 1}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={12}
                  fill="transparent"
                  // No focus ring: a focused dot grows and shows its tooltip.
                  style={{ cursor: "pointer", outline: "none" }}
                  tabIndex={0}
                  role="button"
                  aria-label={p.note}
                  aria-pressed={pinned === p.key}
                  onMouseEnter={() => setHovered(p.key)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(p.key)}
                  onBlur={() => setHovered(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePin(p.key);
                  }}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      togglePin(p.key);
                    }
                  }}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={p.big || active?.key === p.key ? 8 : 6}
                  fill={p.color}
                  stroke="var(--bs-body-bg)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                {p.labelled && (
                  <text
                    {...labelAt(p, cx, cy)}
                    fill="var(--bs-body-color)"
                    stroke="var(--bs-body-bg)"
                    strokeWidth={4}
                    paintOrder="stroke"
                    className="font-monospace"
                    pointerEvents="none"
                  >
                    {p.name}
                  </text>
                )}
              </g>
            );
          })}
          <text x={M.left + PW / 2} y={H - 8} textAnchor="middle" fill={MUTED}>
            ← Cheaper · {axes.x} · More expensive →
          </text>
          <text
            transform={`translate(16 ${M.top + PH / 2}) rotate(-90)`}
            textAnchor="middle"
            fill={MUTED}
          >
            {axes.y}
          </text>
        </svg>
        {active && (
          <Tooltip
            point={active}
            cx={px(active.x)}
            cy={py(active.y)}
            pinned={pinned === active.key}
          />
        )}
      </div>
      {missing > 0 && (
        <figcaption className="small text-body-secondary">
          {missing} {missing === 1 ? "driver has" : "drivers have"} {axes.lacks}{" "}
          and {missing === 1 ? "isn’t" : "aren’t"} plotted.
        </figcaption>
      )}
    </figure>
  );
}

/** Where a dot's name goes: on its preferred side, else the other, else
 *  above or below. */
function labelAt(p: Point, cx: number, cy: number) {
  const room = 12 + 7.5 * p.name.length;
  const fits = (side: -1 | 1) =>
    side < 0 ? cx - M.left >= room : M.left + PW - cx >= room;
  const side = fits(p.side) ? p.side : fits(-p.side as -1 | 1) ? -p.side : 0;
  if (side === 0) {
    return {
      x: cx,
      y: cy + (cy - M.top < 28 ? 24 : -14),
      textAnchor: "middle" as const,
    };
  }
  return {
    x: cx + side * 12,
    y: cy,
    textAnchor: side < 0 ? ("end" as const) : ("start" as const),
    dominantBaseline: "middle" as const,
  };
}

/** The active dot's name, score, and cost, placed over the SVG in
 *  percentages of its viewBox so it follows the chart as it scales: above
 *  the dot, or below it near the top, and kept inside the plot's width. */
function Tooltip({
  point,
  cx,
  cy,
  pinned,
}: {
  point: Point;
  cx: number;
  cy: number;
  pinned: boolean;
}) {
  const across = cx / W;
  const shiftX =
    across < 0.2 ? "-16px" : across > 0.8 ? "calc(-100% + 16px)" : "-50%";
  const below = cy - M.top < 72;
  const shiftY = below ? "16px" : "calc(-100% - 16px)";
  return (
    <div
      className={`position-absolute bg-body border rounded px-2 py-1 small text-nowrap ${pinned ? "shadow" : "shadow-sm"}`}
      style={{
        left: `${across * 100}%`,
        top: `${(cy / H) * 100}%`,
        transform: `translate(${shiftX}, ${shiftY})`,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    >
      <div className="fw-semibold font-monospace">{point.name}</div>
      {point.lines.map(([label, value]) => (
        <div key={label}>
          {label} <span className="font-monospace">{value}</span>
        </div>
      ))}
    </div>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="d-inline-flex align-items-center gap-1">
      <svg width={12} height={12} aria-hidden="true">
        <circle cx={6} cy={6} r={5} fill={color} />
      </svg>
      {label}
    </span>
  );
}
