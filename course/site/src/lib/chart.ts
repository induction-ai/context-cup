/** Scales and ticks for the leaderboard's score-versus-cost chart. Pure, so
 *  the geometry is tested without rendering. */

export type Scale = {
  domain: [number, number];
  ticks: number[];
  /** Domain value to a 0..1 position along the axis. */
  at: (v: number) => number;
};

/** A log scale over positive values: padded by half a step either side,
 *  widened to at least one decade, with ticks at 1 and 3 of each decade. */
export function logScale(values: number[]): Scale {
  const positive = values.filter((v) => v > 0 && Number.isFinite(v));
  let lo = positive.length ? Math.min(...positive) / 1.6 : 0.1;
  let hi = positive.length ? Math.max(...positive) * 1.6 : 10;
  if (hi / lo < 10) {
    const mid = Math.sqrt(lo * hi);
    lo = mid / Math.sqrt(10);
    hi = mid * Math.sqrt(10);
  }
  const ticks: number[] = [];
  for (
    let k = Math.floor(Math.log10(lo));
    k <= Math.ceil(Math.log10(hi));
    k++
  ) {
    for (const m of [1, 3]) {
      const v = Number((m * 10 ** k).toPrecision(1));
      if (v >= lo && v <= hi) ticks.push(v);
    }
  }
  const [a, b] = [Math.log10(lo), Math.log10(hi)];
  return { domain: [lo, hi], ticks, at: (v) => (Math.log10(v) - a) / (b - a) };
}

/** A linear scale over scores in 0..1, snapped out to tenths with some room
 *  around the data, ticks every tenth. */
export function scoreScale(values: number[]): Scale {
  const present = values.filter((v) => Number.isFinite(v));
  const tenth = (v: number) => Math.round(v * 10) / 10;
  let lo = present.length
    ? Math.floor((Math.min(...present) - 0.05) * 10) / 10
    : 0;
  let hi = present.length
    ? Math.ceil((Math.max(...present) + 0.05) * 10) / 10
    : 1;
  lo = Math.max(0, tenth(lo));
  hi = Math.min(1, tenth(hi));
  if (hi - lo < 0.2) {
    if (hi < 1) hi = Math.min(1, tenth(hi + 0.1));
    if (hi - lo < 0.2) lo = Math.max(0, tenth(lo - 0.1));
  }
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.1) ticks.push(tenth(v));
  return { domain: [lo, hi], ticks, at: (v) => (v - lo) / (hi - lo) };
}
