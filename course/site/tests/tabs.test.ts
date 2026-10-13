import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { rowBreaks } from "../src/components/tabs.tsx";

describe("rowBreaks", () => {
  it("leaves tabs that fit on one row alone", () => {
    expect(rowBreaks([50, 60, 70], 200)).toEqual([]);
  });

  it("spreads two rows' worth evenly rather than leaving an orphan", () => {
    // Nine tabs of 100 in 850: a plain wrap gives 8 + 1.
    expect(rowBreaks(Array(9).fill(100), 850)).toEqual([5]);
  });

  it("balances by width, not count", () => {
    // Two wide tabs then four narrow: 300 | 300 + 50 × 4 makes the widest
    // row 500, narrower than 600 | 200.
    expect(rowBreaks([300, 300, 50, 50, 50, 50], 650)).toEqual([1]);
  });

  it("uses as many rows as the width demands, no more", () => {
    expect(rowBreaks(Array(9).fill(100), 320)).toEqual([3, 6]);
  });
});
