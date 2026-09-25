/** A small syntax colourer for the home page's code sample: enough for
 *  Python, JSON, and shell, not a general highlighter. */

export type Language = "python" | "json" | "bash";
export type TokenKind = "keyword" | "name" | "string" | "comment" | "number";
/** A run of text, coloured by its kind or plain when it has none. */
export type Token = { text: string; kind?: TokenKind };

const KEYWORDS: Record<Language, ReadonlySet<string>> = {
  python: new Set(
    "and as def elif else for from if import in is not or return while with None True False".split(
      " "
    )
  ),
  json: new Set(["true", "false", "null"]),
  bash: new Set("set if then else fi for do done in".split(" ")),
};

const PATTERN =
  /(?<comment>#[^\n]*)|(?<string>"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(?<number>\b\d[\d_]*(?:\.\d+)?\b)|(?<word>[A-Za-z_]\w*)/g;

/** The source split into lines of tokens. Python's `def` names and JSON's
 *  keys come out as `name`; a string that spans lines is split at each. */
export function highlight(source: string, language: Language): Token[][] {
  const tokens: Token[] = [];
  let at = 0;
  let afterDef = false;
  for (const m of source.matchAll(PATTERN)) {
    const g = m.groups ?? {};
    const text = m[0];
    const start = m.index;
    if (start > at) tokens.push({ text: source.slice(at, start) });
    at = start + text.length;
    let kind: TokenKind | undefined;
    if (g.comment != null) {
      kind = language === "json" ? undefined : "comment";
    } else if (g.string != null) {
      const key =
        language === "json" && /^\s*:/.test(source.slice(start + text.length));
      kind = key ? "name" : "string";
    } else if (g.number != null) {
      kind = "number";
    } else if (KEYWORDS[language].has(text)) {
      kind = "keyword";
    } else if (afterDef) {
      kind = "name";
    }
    afterDef = language === "python" && text === "def";
    tokens.push(kind ? { text, kind } : { text });
  }
  if (at < source.length) tokens.push({ text: source.slice(at) });

  const lines: Token[][] = [[]];
  for (const token of tokens) {
    token.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ ...token, text: part });
    });
  }
  return lines;
}
