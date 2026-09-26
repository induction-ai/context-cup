/** A small syntax colourer for the home page's code samples: enough for
 *  the base drivers in Python and TypeScript, not a general highlighter. */

export type Language = "python" | "typescript";
export type TokenKind = "keyword" | "name" | "string" | "comment" | "number";
/** A run of text, coloured by its kind or plain when it has none. */
export type Token = { text: string; kind?: TokenKind };

const LANGUAGES: Record<
  Language,
  {
    /** A regex source matching one comment. */
    comment: string;
    keywords: ReadonlySet<string>;
    defines: string;
    /** Whether `word:` is a key (TypeScript's object keys) rather than a
     *  keyword (Python's `else:`). */
    keyColon: boolean;
  }
> = {
  python: {
    comment: String.raw`#[^\n]*`,
    keywords: new Set(
      "and as async await break class continue def elif else except finally for from if import in is lambda not or pass raise return try while with yield None True False".split(
        " "
      )
    ),
    defines: "def",
    keyColon: false,
  },
  typescript: {
    comment: String.raw`//[^\n]*|/\*[\s\S]*?\*/`,
    keywords: new Set(
      "as async await break catch class const continue else export extends for from function if import in interface let new of return throw try type typeof null true false undefined".split(
        " "
      )
    ),
    defines: "function",
    keyColon: true,
  },
};

function pattern(comment: string): RegExp {
  return new RegExp(
    String.raw`(?<comment>${comment})|(?<string>"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\`(?:\\.|[^\`\\])*\`)|(?<number>\b\d[\d_]*(?:\.\d+)?\b)|(?<word>[A-Za-z_]\w*)`,
    "g"
  );
}

/** The source split into lines of tokens. The name a `def` or `function`
 *  introduces comes out as `name`, a keyword read as a property or a key
 *  (`part.type`, `{ type: … }`) as plain text, and a string that spans lines is split at each. */
export function highlight(source: string, language: Language): Token[][] {
  const { comment, keywords, defines, keyColon } = LANGUAGES[language];
  const tokens: Token[] = [];
  let at = 0;
  let afterDefine = false;
  for (const m of source.matchAll(pattern(comment))) {
    const g = m.groups ?? {};
    const text = m[0];
    if (m.index > at) tokens.push({ text: source.slice(at, m.index) });
    at = m.index + text.length;
    const kind: TokenKind | undefined =
      g.comment != null
        ? "comment"
        : g.string != null
          ? "string"
          : g.number != null
            ? "number"
            : keywords.has(text) &&
                source[m.index - 1] !== "." &&
                !(keyColon && /^\s*:/.test(source.slice(at)))
              ? "keyword"
              : afterDefine
                ? "name"
                : undefined;
    afterDefine = text === defines;
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
