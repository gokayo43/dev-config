/**
 * Where a text's comments are, in JavaScript's lexical grammar: a config's,
 * which `withoutComments` reads for the JSON-with-comments dialect, and a
 * source file's, which the duplicate-code gate normalises with
 * `commentsBlanked`. Those two are the module's face; the scan behind them is
 * its own subject, which is why it is not in `gate.ts`.
 */

/**
 * The text with its comments and trailing commas blanked out. README asks a
 * repo to write the reason for an override beside it, and oxlint's schema
 * declares `allowComments` and `allowTrailingCommas` while TypeScript has
 * always taken both — so a gate that refused the reason it asked for would be
 * refusing a valid file. Blanked rather than deleted so a parse error still
 * points at the character it is about — and so a line that has something in the
 * file and nothing here is exactly a comment, which is how the repo contract
 * finds the reason written above an override.
 */
export function withoutComments(text: string): string {
  const kept: string[] = [];
  const commas: number[] = [];
  for (const span of lexed(text)) {
    const blanked = span.kind === "comment" ? asBlank(span.text) : span.text;
    for (const char of blanked.split("")) {
      if (span.kind === "code" && char === ",") commas.push(kept.length);
      kept.push(char);
    }
  }
  for (const at of commas) {
    if (closesNext(kept, at)) kept[at] = " ";
  }
  return kept.join("");
}

/**
 * The text with its comments blanked and everything else as written, newlines
 * included, so line `n` here is line `n` of the file. What the duplicate-code
 * gate compares, and the half of `withoutComments` that is not about JSON.
 */
export function commentsBlanked(text: string): string {
  return lexed(text)
    .map((span) => (span.kind === "comment" ? asBlank(span.text) : span.text))
    .join("");
}

/** A comment as the whitespace it stands in for: its newlines kept, everything else a space. */
function asBlank(comment: string): string {
  return comment.replace(/[^\n]/g, " ");
}

/** Whether the next thing after the comma at `at` closes its object or array, making it trailing. */
function closesNext(kept: readonly string[], at: number): boolean {
  for (let index = at + 1; index < kept.length; index += 1) {
    const char = kept[index] ?? "";
    if (char.trim() === "") continue;
    return char === "}" || char === "]";
  }
  return false;
}

/**
 * What a stretch of text is, as far as finding its comments goes: a literal is
 * whatever a comment marker inside it cannot start — a string, a template's
 * text, a regular expression.
 */
interface Span {
  readonly kind: "code" | "literal" | "comment";
  readonly text: string;
}

/** The words after which a `/` begins a regular expression rather than dividing. */
const BEFORE_A_PATTERN = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const WORD = /[\p{ID_Continue}$]/u;

/**
 * The text cut into code, literals and comments, which concatenate back to it.
 * JavaScript's lexical grammar rather than JSON's, because JSON with comments
 * is a subset of it: the one scan serves both a config and a source file, and
 * `//` inside a string, a template or a pattern is data — the `$schema` line at
 * the top of a config is a URL, and a stripper that ate it would turn a working
 * file into the failure it was written to prevent.
 *
 * A scan rather than a regex. Two judgements no scan without a parser can make
 * exactly are made the usual way: a `/` begins a pattern unless what precedes
 * it ends a value (a word that is not a keyword, a `)`, a `]`, a literal), and
 * a quote that reaches the end of its line ends there, so text that only looks
 * like a string — an apostrophe in JSX — costs one line rather than the rest
 * of the file.
 */
function lexed(text: string): Span[] {
  const spans: Span[] = [];
  const scan: Scan = { depth: 0, templates: [], last: "", word: "" };
  let code = "";
  let index = 0;
  while (index < text.length) {
    const found = spanAt(text, index, scan);
    if (found === undefined) {
      remember(scan, text, index);
      code += text[index];
      index += 1;
      continue;
    }
    if (code !== "") spans.push({ kind: "code", text: code });
    code = "";
    spans.push({ kind: found.kind, text: text.slice(index, found.end) });
    index = found.end;
  }
  if (code !== "") spans.push({ kind: "code", text: code });
  return spans;
}

/** What the scan has to remember about the code behind it. */
interface Scan {
  /** How many `{` are open in code. */
  depth: number;
  /** The depth each open `${` returns to its template at. */
  readonly templates: number[];
  /** The last character of code that was not whitespace, or `LITERAL` where a literal ended since. */
  last: string;
  /** The word ending at `last`, when `last` ends one. */
  word: string;
}

/** What `last` holds once a literal has ended: a value, so a `/` after it divides. */
const LITERAL = '"';

/** The comment or literal opening at `index`, with where it ends, or nothing where the character is code. */
function spanAt(
  text: string,
  index: number,
  scan: Scan,
): { readonly kind: "literal" | "comment"; readonly end: number } | undefined {
  const char = text[index];
  const next = text[index + 1];
  if (char === "/" && next === "/") {
    return { kind: "comment", end: nextIndexOf(text, "\n", index + 2) };
  }
  if (char === "/" && next === "*") {
    return { kind: "comment", end: Math.min(text.length, nextIndexOf(text, "*/", index + 2) + 2) };
  }
  if (char === '"' || char === "'" || (char === "/" && beginsPattern(scan))) {
    scan.last = LITERAL;
    return {
      kind: "literal",
      end: char === "/" ? patternEnd(text, index) : quotedEnd(text, index),
    };
  }
  if (char === "`" || (char === "}" && scan.templates.at(-1) === scan.depth)) {
    if (char === "}") scan.templates.pop();
    const end = templateEnd(text, index + 1);
    const interrupted = text.startsWith("${", end - 2);
    if (interrupted) scan.templates.push(scan.depth);
    // Inside `${` is the start of an expression, where a `/` opens a pattern.
    scan.last = interrupted ? "{" : LITERAL;
    return { kind: "literal", end };
  }
  return undefined;
}

/** A character of code, into what the scan remembers. */
function remember(scan: Scan, text: string, index: number): void {
  const char = text[index] ?? "";
  if (char === "{") scan.depth += 1;
  if (char === "}") scan.depth -= 1;
  if (char.trim() === "") return;
  const continues = text[index - 1] === scan.last && WORD.test(scan.last);
  scan.word = WORD.test(char) ? (continues ? scan.word : "") + char : "";
  scan.last = char;
}

/** Whether a `/` here starts a pattern: after a keyword or an operator it does, after a value it divides. */
function beginsPattern({ last, word }: Scan): boolean {
  if (WORD.test(last)) return BEFORE_A_PATTERN.has(word);
  return last !== ")" && last !== "]" && last !== LITERAL;
}

/** Where the quoted string opening at `from` ends: after its closing quote, or at the end of its line. */
function quotedEnd(text: string, from: number): number {
  const quote = text[from];
  let index = from + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === quote) return index + 1;
    else if (char === "\n") return index;
    else index += 1;
  }
  return text.length;
}

/** Where a template's text running from `from` ends: after its closing backtick or the `${` that interrupts it. */
function templateEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === "`") return index + 1;
    else if (char === "$" && text[index + 1] === "{") return index + 2;
    else index += 1;
  }
  return text.length;
}

/** Where the pattern opening at `from` ends: after its closing slash, or at the end of its line. */
function patternEnd(text: string, from: number): number {
  let index = from + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === "\n") return index;
    else {
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) return index + 1;
      index += 1;
    }
  }
  return text.length;
}

/** Where `needle` next appears, or the end of the text when it does not appear again. */
function nextIndexOf(text: string, needle: string, from: number): number {
  const at = text.indexOf(needle, from);
  return at === -1 ? text.length : at;
}
