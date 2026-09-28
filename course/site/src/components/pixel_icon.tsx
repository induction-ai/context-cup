/** Small pixel-art icons: rectangles on a 16-unit grid, drawn crisp and in
 *  `currentColor`, so a parent's `color` paints them. */

type Rect = [x: number, y: number, w: number, h: number];

/** A checker of `cols` by `rows` cells, `size` units each, from (x, y). */
function checker(x: number, y: number, cols: number, rows: number, size = 3) {
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 === 0)
        cells.push([x + c * size, y + r * size, size, size]);
    }
  }
  return cells;
}

export const ICONS = {
  flag: checker(0, 2, 4, 3, 4),
  trophy: [
    [2, 1, 12, 2],
    [3, 3, 10, 4],
    [4, 7, 8, 2],
    [6, 9, 4, 1],
    [7, 10, 2, 2],
    [4, 12, 8, 3],
    [0, 2, 2, 1],
    [0, 3, 1, 3],
    [1, 6, 2, 1],
    [14, 2, 2, 1],
    [15, 3, 1, 3],
    [13, 6, 2, 1],
  ],
  calendar: [
    [4, 0, 2, 3],
    [10, 0, 2, 3],
    [1, 2, 14, 4],
    [1, 6, 2, 9],
    [13, 6, 2, 9],
    [3, 13, 10, 2],
    [4, 7, 2, 2],
    [7, 7, 2, 2],
    [10, 7, 2, 2],
    [4, 10, 2, 2],
    [7, 10, 2, 2],
    [10, 10, 2, 2],
  ],
  stopwatch: [
    [6, 0, 4, 2],
    [7, 2, 2, 1],
    [5, 3, 6, 2],
    [3, 4, 2, 2],
    [11, 4, 2, 2],
    [2, 6, 2, 2],
    [12, 6, 2, 2],
    [1, 8, 2, 4],
    [13, 8, 2, 4],
    [2, 12, 2, 2],
    [12, 12, 2, 2],
    [3, 14, 2, 1],
    [11, 14, 2, 1],
    [5, 14, 6, 2],
    [7, 6, 2, 4],
    [9, 8, 2, 2],
  ],
  document: [
    [3, 1, 7, 2],
    [3, 3, 2, 12],
    [11, 5, 2, 10],
    [5, 13, 6, 2],
    [10, 3, 1, 1],
    [10, 4, 2, 1],
    [6, 6, 4, 1],
    [6, 8, 4, 1],
    [6, 10, 4, 1],
  ],
  menu: [
    [1, 3, 14, 2],
    [1, 7, 14, 2],
    [1, 11, 14, 2],
  ],
  close: [
    [2, 2, 2, 2],
    [4, 4, 2, 2],
    [6, 6, 4, 4],
    [10, 4, 2, 2],
    [12, 2, 2, 2],
    [4, 10, 2, 2],
    [2, 12, 2, 2],
    [10, 10, 2, 2],
    [12, 12, 2, 2],
  ],
  arrow: [
    [1, 7, 11, 2],
    [8, 3, 2, 2],
    [10, 5, 2, 2],
    [12, 7, 2, 2],
    [10, 9, 2, 2],
    [8, 11, 2, 2],
  ],
  bars: [
    [2, 9, 3, 5],
    [7, 6, 3, 8],
    [12, 2, 3, 12],
  ],
} satisfies Record<string, Rect[]>;

export type IconName = keyof typeof ICONS;

export function PixelIcon({
  name,
  size = 28,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`cc-pixel${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      {ICONS[name].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} />
      ))}
    </svg>
  );
}
