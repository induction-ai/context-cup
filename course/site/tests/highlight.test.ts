import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { highlight } from "../src/lib/highlight.ts";

describe("highlight", () => {
  it("colours Python keywords, def names, strings, comments, and numbers", () => {
    const [first, second] = highlight(
      'def run(ctx):  # go\n    return "x", 3',
      "python"
    );
    expect(first).toEqual([
      { text: "def", kind: "keyword" },
      { text: " " },
      { text: "run", kind: "name" },
      { text: "(" },
      { text: "ctx" },
      { text: "):  " },
      { text: "# go", kind: "comment" },
    ]);
    expect(second).toEqual([
      { text: "    " },
      { text: "return", kind: "keyword" },
      { text: " " },
      { text: '"x"', kind: "string" },
      { text: ", " },
      { text: "3", kind: "number" },
    ]);
  });

  it("colours TypeScript with // comments, function names, and no # comments", () => {
    const [first, second] = highlight(
      'export async function run(ctx) { // go\n  return "#x";',
      "typescript"
    );
    expect(first).toEqual([
      { text: "export", kind: "keyword" },
      { text: " " },
      { text: "async", kind: "keyword" },
      { text: " " },
      { text: "function", kind: "keyword" },
      { text: " " },
      { text: "run", kind: "name" },
      { text: "(" },
      { text: "ctx" },
      { text: ") { " },
      { text: "// go", kind: "comment" },
    ]);
    expect(second).toEqual([
      { text: "  " },
      { text: "return", kind: "keyword" },
      { text: " " },
      { text: '"#x"', kind: "string" },
      { text: ";" },
    ]);
  });

  it("leaves a keyword used as a property or a key plain", () => {
    expect(highlight("part.type", "typescript")[0]).toEqual([
      { text: "part" },
      { text: "." },
      { text: "type" },
    ]);
    expect(highlight("{ type: 1 }", "typescript")[0]).toEqual([
      { text: "{ " },
      { text: "type" },
      { text: ": " },
      { text: "1", kind: "number" },
      { text: " }" },
    ]);
    expect(highlight("else:", "python")[0]).toEqual([
      { text: "else", kind: "keyword" },
      { text: ":" },
    ]);
  });

  it("splits a docstring across its lines and keeps blank lines", () => {
    expect(highlight('"""one\ntwo"""\n\nx', "python")).toEqual([
      [{ text: '"""one', kind: "string" }],
      [{ text: 'two"""', kind: "string" }],
      [],
      [{ text: "x" }],
    ]);
  });

  it("reads TypeScript block comments and template strings whole", () => {
    expect(highlight("/** a\n *  b */\nx = `${y} z`;", "typescript")).toEqual([
      [{ text: "/** a", kind: "comment" }],
      [{ text: " *  b */", kind: "comment" }],
      [
        { text: "x" },
        { text: " = " },
        { text: "`${y} z`", kind: "string" },
        { text: ";" },
      ],
    ]);
  });
});
