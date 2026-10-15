import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { driverUrl, REPO_URL } from "../src/lib/links.ts";

describe("links", () => {
  it("points a driver at its folder in the repo", async () => {
    expect(driverUrl("base_python")).toBe(
      `${REPO_URL}/tree/main/drivers/base_python`
    );
  });
});
