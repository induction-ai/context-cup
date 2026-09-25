import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { logScale, scoreScale } from "../src/lib/chart.ts";

describe("chart scales", () => {
  it("puts log ticks at 1 and 3 of each decade and spans at least one", async () => {
    const x = logScale([0.5, 12]);
    expect(x.ticks).toEqual([1, 3, 10]);
    expect(x.at(x.domain[0])).toBeCloseTo(0, 9);
    expect(x.at(x.domain[1])).toBeCloseTo(1, 9);
    expect(x.at(1)).toBeLessThan(x.at(3));
    const narrow = logScale([2, 2.5]);
    expect(narrow.domain[1] / narrow.domain[0]).toBeGreaterThanOrEqual(
      10 - 1e-9
    );
    expect(narrow.ticks.length).toBeGreaterThanOrEqual(2);
    // Zeros and negatives cannot sit on a log axis.
    expect(logScale([0, -1, 4]).ticks).toContain(3);
  });

  it("snaps score axes out to tenths within 0..1", async () => {
    expect(scoreScale([0.42, 0.61]).ticks).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(scoreScale([0, 1]).domain).toEqual([0, 1]);
    const tight = scoreScale([0.97]);
    expect(tight.domain[1]).toBe(1);
    expect(tight.domain[1] - tight.domain[0]).toBeGreaterThanOrEqual(
      0.2 - 1e-9
    );
  });
});
