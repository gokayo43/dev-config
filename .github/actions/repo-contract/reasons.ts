/**
 * Where a config written in JSON with comments switches something off, and
 * whether the reason for it is written above it. The contract asks this of
 * `.oxlintrc.json` and of every tsconfig, which say "off" in two vocabularies —
 * a rule's `AllowWarnDeny`, a compiler flag's relaxing boolean — and owe the
 * same reason in the same place. So the vocabulary is the caller's and the
 * reading is this module's: two readings of what counts as a reason above an
 * entry would drift apart the first time either learned a new comment shape.
 */
import { withoutComments } from "../_lib/comments.ts";

/** Whether the setting written at `at`, under the member `name`, switches something off. */
type Silences = (text: string, at: number, name: string) => boolean;

/**
 * The blocks whose members can switch something off, and what switching off
 * looks like in each. Keyed by path with array indices dropped, so one entry
 * covers every element of a list of blocks.
 */
export type Switches = ReadonlyMap<string, Silences>;

/** A switch-off with no reason above it: the member it sets, and its line, counted from 1. */
export interface Unreasoned {
  readonly name: string;
  readonly line: number;
  /** Whether it shares its line with another entry, which no reason above can tell apart from it. */
  readonly crowded: boolean;
}

/**
 * Where a switch-off is written: the name it switches off, and the line it is
 * on (counted from zero).
 */
interface OffSite {
  readonly name: string;
  readonly line: number;
}

/** The JSON string starting at `at`, decoded, and the index just past its closing quote. */
export function stringAt(
  text: string,
  at: number,
): { readonly value: string; readonly end: number } {
  let index = at + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      const end = index + 1;
      // Decoded rather than sliced, so the file has one spelling of each name
      // and each setting: `"off"` is a string oxlint reads as `off`,
      // and a gate comparing raw bytes reads it as something else entirely.
      const decoded: unknown = JSON.parse(text.slice(at, end));
      return { value: typeof decoded === "string" ? decoded : "", end };
    }
    index += 1;
  }
  return { value: "", end: text.length };
}

export function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && (text[index] ?? "").trim() === "") index += 1;
  return index;
}

/** The line `at` falls on, counted from zero. */
function lineOf(text: string, at: number): number {
  let line = 0;
  for (let index = 0; index < at; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

/** What one walk of a config's text found: where it silences something, and how crowded each line is. */
interface Walk {
  readonly sites: OffSite[];
  /**
   * How many entries of a silencing block each line carries. Only those are
   * counted: an options object hanging off a rule that is staying on is not
   * something a reason could be about, so it cannot make one ambiguous.
   */
  readonly entries: Map<number, number>;
}

/**
 * Every switch-off in the config, found in one walk of its comment-blanked
 * text. One walk because off-ness has to be decided once: a pass that collected
 * names from the parse and then searched the text for them decides it twice, in
 * two dialects, and the two answers drift the first time a spelling is added.
 * The walk carries the path it is inside, which is what tells a `rules` block
 * from `globals` without asking the parse anything.
 */
function walkConfig(blanked: string, switches: Switches): Walk {
  const sites: OffSite[] = [];
  const entries = new Map<number, number>();
  const path: string[] = [];
  let key: string | undefined;
  let index = 0;
  while (index < blanked.length) {
    const char = blanked[index];
    if (char === '"') {
      const { value, end } = stringAt(blanked, index);
      const colon = skipSpace(blanked, end);
      if (blanked[colon] !== ":") {
        index = end;
        continue;
      }
      const line = lineOf(blanked, index);
      const setting = skipSpace(blanked, colon + 1);
      const silences = switches.get(path.filter((step) => step !== "").join("."));
      if (silences !== undefined) {
        entries.set(line, (entries.get(line) ?? 0) + 1);
        if (silences(blanked, setting, value)) sites.push({ name: value, line });
      }
      key = value;
      index = setting;
      continue;
    }
    if (char === "{" || char === "[") {
      path.push(key ?? "");
      key = undefined;
    } else if (char === "}" || char === "]") {
      path.pop();
      key = undefined;
    }
    index += 1;
  }
  return { sites, entries };
}

/**
 * The comment lines above `line`, as the prose in them. Comment syntax is
 * stripped rather than trusted, because `//` and `/**\/` are a comment that says
 * nothing — the same empty waiver `allowlistFrom` already refuses, in the other
 * dialect a repo writes reasons in.
 *
 * A reason covers the contiguous **group of switch-offs** under it, not only the
 * first of them. One argument routinely retires several rules at once — the
 * paragraph explaining why `pedantic`, `style`, `restriction` and `nursery` are
 * not adopted is one reason about four of them, and writing it out four times
 * is what a rule demanding a comment per line actually asks for. So the walk
 * steps over the switch-offs above on its way up, and stops at everything else.
 *
 * A switch-off, rather than an entry, is what continues the group, and that is
 * the whole tightness of it: a rule left ON is a different subject, so the
 * comment above THAT is about the rule staying on and cannot be spent down here.
 * `oxlint.base.json` is the case — `"react/exhaustive-deps": "warn"` sits
 * between the JSX runtime's reason and `oxc/no-map-spread`, and a walk that
 * counted entries would hand the first's argument to the second. A blank line
 * closes the group as well, and so does any line carrying nothing at all: the
 * `"rules": {` a block opens with, or a multi-line entry's continuation.
 */
function reasonAbove(
  written: readonly string[],
  stripped: readonly string[],
  switchedOff: ReadonlySet<number>,
  line: number,
): string {
  let above = line - 1;
  while (above >= 0 && switchedOff.has(above)) above -= 1;
  const prose: string[] = [];
  for (; above >= 0; above -= 1) {
    const text = written[above] ?? "";
    if (text.trim() === "" || (stripped[above] ?? "").trim() !== "") break;
    prose.push(
      text
        .trim()
        .replace(/^\/\*/, "")
        .replace(/\*\/$/, "")
        .replace(/^\/\//, "")
        .replace(/^\*+/, "")
        .trim(),
    );
  }
  return prose.join(" ").trim();
}

/**
 * Every switch-off in the config with no reason above it. The reason is owed
 * per switch-off, not per line, so a switch-off sharing its line with any other
 * entry is refused outright: a comment above two entries on one line says
 * nothing about which of them it excuses, and a reader cannot recover the
 * difference. A comment above a run of switch-offs written one per line is the
 * opposite case and is read as covering that run — `reasonAbove` has the
 * argument. Read out of the text rather than the parse, because the parse is
 * precisely what drops the comment.
 */
export function unreasoned(text: string, switches: Switches): Unreasoned[] {
  const blanked = withoutComments(text);
  const written = text.split("\n");
  const stripped = blanked.split("\n");
  const { sites, entries } = walkConfig(blanked, switches);
  const switchedOff = new Set(sites.map(({ line }) => line));
  return sites.flatMap(({ name, line }) => {
    const crowded = (entries.get(line) ?? 0) > 1;
    if (!crowded && reasonAbove(written, stripped, switchedOff, line) !== "") return [];
    return [{ name, line: line + 1, crowded }];
  });
}
