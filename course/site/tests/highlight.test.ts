import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { highlight } from "../src/lib/highlight.ts";

describe("highlight", () => {
  it("colours Python keywords, def names, strings, comments, and numbers", () => {
    const [line] = highlight(
      'def run(ctx):  # go\n    return "x", 3',
      "python"
    );
    expect(line).toEqual([
      { text: "def", kind: "keyword" },
      { text: " " },
      { text: "run", kind: "name" },
      { text: "(" },
      { text: "ctx" },
      { text: "):  " },
      { text: "# go", kind: "comment" },
    ]);
    expect(highlight('def f():\n    return "x", 3', "python")[1]).toEqual([
      { text: "    " },
      { text: "return", kind: "keyword" },
      { text: " " },
      { text: '"x"', kind: "string" },
      { text: ", " },
      { text: "3", kind: "number" },
    ]);
  });

  it("splits a docstring across its lines", () => {
    const lines = highlight('"""one\ntwo"""\nx', "python");
    expect(lines).toEqual([
      [{ text: '"""one', kind: "string" }],
      [{ text: 'two"""', kind: "string" }],
      [{ text: "x" }],
    ]);
  });

  it("tells JSON keys from values", () => {
    expect(
      highlight('{ "keep": 3, "kind": "driver", "on": true }', "json")[0]
    ).toEqual([
      { text: "{ " },
      { text: '"keep"', kind: "name" },
      { text: ": " },
      { text: "3", kind: "number" },
      { text: ", " },
      { text: '"kind"', kind: "name" },
      { text: ": " },
      { text: '"driver"', kind: "string" },
      { text: ", " },
      { text: '"on"', kind: "name" },
      { text: ": " },
      { text: "true", kind: "keyword" },
      { text: " }" },
    ]);
  });

  it("keeps blank lines", () => {
    expect(highlight("a\n\nb", "bash")).toEqual([
      [{ text: "a" }],
      [],
      [{ text: "b" }],
    ]);
  });
});
