import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { branchChange, scratchRepository } from "../_lib/change-set.ts";
import { commentsBlanked } from "../_lib/comments.ts";
import {
  commanded,
  type Directive,
  directivesIn,
  type Event,
  KEEP_CLONE,
  plural,
  type Problem,
  REASON,
  SOURCE,
  trackedFiles,
  type Verdict,
} from "../_lib/gate.ts";

/**
 * The shortest run of normalised lines that counts as a clone. Not an input: a
 * per-repo number is the first thing a red run asks for, and a floor every repo
 * can move is a floor no repo has. docs/gates/duplicate-code.md says why twelve.
 */
const WINDOW = 12;

/**
 * Of what `SOURCE` lists, what is somebody's hand-written code: never a
 * declaration file, and never anything under a `dist` folder, which a repo that
 * commits its build — this one does — holds as a second copy of its source.
 */
function isGraded(path: string): boolean {
  return !path.endsWith(".d.ts") && !path.split("/").includes("dist");
}

const READS_THE_BASE_REF =
  "the gate looks for clones among the lines this branch wrote, and the base ref is what they are measured against";

/** A line a comment or whitespace change cannot move: its number in the file, and its text. */
export interface Line {
  /** Where it is in the file, from 1. */
  readonly at: number;
  readonly text: string;
}

/**
 * A file's lines as the gate compares them: comments and blank lines gone, and
 * every run of whitespace one space. What reformatting, re-indenting or
 * re-commenting a block cannot change is what a copy keeps.
 */
export function normalised(source: string): Line[] {
  return commentsBlanked(source)
    .split("\n")
    .flatMap((raw, index) => {
      const text = raw.replace(/\s+/g, " ").trim();
      return text === "" ? [] : [{ at: index + 1, text }];
    });
}

/** The directive that keeps a clone, as a comment spells it. */
const DIRECTIVE = new RegExp(String.raw`(?:\/\/|\/\*)\s*${KEEP_CLONE}\b`);

interface Source {
  readonly file: string;
  /**
   * Each normalised line as a number shared by every line with its text, so a
   * window compares as numbers. Before each line a directive this branch wrote
   * marks as a block's start sits a number no other entry anywhere shares: no
   * window holding it matches, and a run grows up to it and stops.
   */
  readonly ids: readonly number[];
  /** The file's line each entry of `ids` stands for — for a mark, the directive's. */
  readonly at: readonly number[];
  /** The lines this branch wrote, by number — none, for a file it did not change. */
  readonly written: ReadonlySet<number>;
  /** The reason each mark's directive gives, by the index of the line after the mark. */
  readonly kept: ReadonlyMap<number, string>;
}

/** A run of normalised lines in one file, by the index of its first. */
interface Place {
  readonly source: Source;
  readonly start: number;
}

/** Two places sharing `length` normalised lines; `here` holds a line this branch wrote. */
interface Clone {
  readonly here: Place;
  readonly there: Place;
  readonly length: number;
}

export interface Input {
  readonly root: string;
  readonly event: Event;
}

/**
 * Fails on a run of at least `WINDOW` normalised lines, one of them written by
 * this branch, that also appears anywhere else in the repo's source — in
 * another file, or elsewhere in the same one.
 *
 * Every window of `WINDOW` lines in every source file is indexed by its text;
 * a window in a changed file holding a line the branch wrote, whose text is
 * indexed somewhere else, is a clone, and it is reported once, extended both
 * ways to the longest run the two places share.
 */
export async function duplicateCode({ root, event }: Input): Promise<Verdict> {
  const change = await branchChange(root, event, {
    why: READS_THE_BASE_REF,
    pathspecs: SOURCE,
    keeps: isGraded,
    noun: "source file",
    nothing: "nothing to look for",
  });
  if (change.kind === "settled") return change.verdict;

  const listed = (await trackedFiles(root, SOURCE)).filter(isGraded);
  const generated = await generatedAmong(root, listed);
  const changed = new Map([...change.changed].filter(([file]) => !generated.has(file)));
  if (changed.size === 0) {
    return {
      note: "no source file changed outside the generated ones — nothing to look for",
      problems: [],
    };
  }

  const sources = await readSources(
    root,
    listed.filter((file) => !generated.has(file)),
    changed,
  );
  const index = windowIndex(sources);
  const judged = uniquePairs(
    [...changed.keys()].toSorted().flatMap((file) => {
      // A changed file that is not among the sources is a tracked symlink, which is not read.
      const source = sources.get(file);
      return source === undefined ? [] : clonesIn(source, index);
    }),
  );

  const refused = judged.filter(({ reason }) => reason === undefined).map(({ clone }) => clone);
  const kept = judged.flatMap(({ clone, reason }) =>
    reason === undefined ? [] : [keptLine(clone, reason)],
  );
  const files = plural(changed.size, "changed source file");
  const keptNote = kept.length === 0 ? "" : `; ${plural(kept.length, "clone")} kept by directive`;
  return {
    note:
      refused.length === 0
        ? `no clone of ${WINDOW} or more lines this branch wrote in ${files}${keptNote}`
        : `${plural(refused.length, "clone")} this branch wrote in ${files}${keptNote}`,
    log: kept.join("\n"),
    problems: refused.map(cloneProblem),
  };
}

/**
 * The files git marks `linguist-generated`, which is the attribute GitHub reads
 * to fold a generated file away in a pull request, so one marking serves both.
 * A generator's output repeats itself by design and is rewritten wholesale, so
 * a directive written into it would not survive the next run.
 *
 * The marking that counts is the one the repo commits, so the question is
 * asked of `HEAD`'s tree from a scratch repository, which reads the tree's
 * `.gitattributes` and not the checkout's `info/attributes`, and, with the pin,
 * not the reader's own attributes file either.
 */
async function generatedAmong(root: string, files: readonly string[]): Promise<Set<string>> {
  await using scratch = await scratchRepository(root);
  const answered = await scratch.git(
    [
      "-c",
      "core.attributesFile=/dev/null",
      "check-attr",
      `--source=${scratch.head}`,
      "-z",
      "--stdin",
      "linguist-generated",
    ],
    files.map((file) => `${scratch.prefix}${file}\0`).join(""),
  );
  if (!answered.ok) throw new Error(`git check-attr failed for ${root}`);
  // `-z` answers path, attribute and value per file, each ended by a NUL. A
  // value of `set` is the bare attribute and `true` is `=true`; `unset`,
  // `false` and `unspecified` are a file nobody marked.
  const fields = answered.stdout.split("\0");
  const generated = new Set<string>();
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const value = fields[at + 2];
    if (value === "set" || value === "true") {
      generated.add((fields[at] ?? "").slice(scratch.prefix.length));
    }
  }
  return generated;
}

/**
 * Every graded source file, read and normalised. A symlink is skipped rather
 * than followed: its target is either another tracked file, read as itself, or
 * somewhere outside the checkout, which is not this repo's code to grade.
 */
async function readSources(
  root: string,
  files: readonly string[],
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<Map<string, Source>> {
  const shared = new Map<string, number>();
  let marks = 0;
  const read = await Promise.all(
    files.map(async (file): Promise<Source | undefined> => {
      const path = join(root, file);
      if ((await lstat(path)).isSymbolicLink()) return undefined;
      const text = await Bun.file(path).text();
      const written = changed.get(file) ?? new Set<number>();
      const directives = new Map(
        written.size === 0
          ? []
          : directivesIn(text, DIRECTIVE).map((each): [number, Directive] => [each.line, each]),
      );
      const ids: number[] = [];
      const at: number[] = [];
      const kept = new Map<number, string>();
      let previous: number | undefined;
      for (const line of normalised(text)) {
        const directive = directiveFor(line.at, directives, previous);
        if (directive !== undefined && written.has(directive.line)) {
          marks += 1;
          ids.push(-marks);
          at.push(directive.line);
          kept.set(ids.length, directive.reason);
        }
        const known = shared.get(line.text);
        const id = known ?? shared.size;
        if (known === undefined) shared.set(line.text, id);
        ids.push(id);
        at.push(line.at);
        previous = line.at;
      }
      return { file, ids, at, written, kept };
    }),
  );
  return new Map(
    read.filter((source) => source !== undefined).map((source) => [source.file, source]),
  );
}

function keyAt(ids: readonly number[], start: number): string {
  return ids.slice(start, start + WINDOW).join(",");
}

/** Every window of every file by its text, and under it, where each file holds it. */
function windowIndex(sources: ReadonlyMap<string, Source>): Map<string, Map<Source, number[]>> {
  const index = new Map<string, Map<Source, number[]>>();
  for (const source of sources.values()) {
    for (let start = 0; start + WINDOW <= source.ids.length; start += 1) {
      const key = keyAt(source.ids, start);
      const found = index.get(key) ?? new Map<Source, number[]>();
      index.set(key, found);
      const starts = found.get(source);
      if (starts === undefined) found.set(source, [start]);
      else starts.push(start);
    }
  }
  return index;
}

/**
 * The directive marking a block that starts on line `at`: on the line itself,
 * or on the line directly above it where that line is a comment of its own —
 * the shape every other directive here takes. A directive trailing the code
 * above belongs to that line's block, not to this one.
 */
function directiveFor(
  at: number,
  directives: ReadonlyMap<number, Directive>,
  previous: number | undefined,
): Directive | undefined {
  return directives.get(at) ?? (previous === at - 1 ? undefined : directives.get(at - 1));
}

/** A clone as it is reported, and the reason a directive gives for keeping it, if one does. */
interface Judged {
  readonly clone: Clone;
  readonly reason: string | undefined;
}

/**
 * The clones a changed file's own lines take part in, each extended to the
 * longest run both places share.
 *
 * Each normalised line of the file takes part in at most one reported clone
 * with any one other file, and in at most one with itself: once a run is
 * reported, a window starting inside it is not matched against that file
 * again. That is what keeps the work linear in the file — a window inside a
 * reported run costs one lookup, not a fresh extension.
 */
function clonesIn(
  here: Source,
  index: ReadonlyMap<string, ReadonlyMap<Source, readonly number[]>>,
): Judged[] {
  const own = here.at.map((line) => here.written.has(line));
  const covers = new Map<Source, Uint8Array>();
  const coverFor = (source: Source): Uint8Array => {
    const found = covers.get(source) ?? new Uint8Array(here.ids.length);
    covers.set(source, found);
    return found;
  };
  const judged: Judged[] = [];
  for (let start = 0; start + WINDOW <= here.ids.length; start += 1) {
    if (!own.slice(start, start + WINDOW).includes(true)) continue;
    for (const [source, starts] of index.get(keyAt(here.ids, start)) ?? []) {
      const cover = coverFor(source);
      if (cover[start] === 1) continue;
      const at = starts.find(
        (each) => source !== here || (Math.abs(each - start) >= WINDOW && cover[each] !== 1),
      );
      if (at === undefined) continue;
      const run = extended(here, start, { source, start: at });
      judged.push({ clone: reportedAs(run, cover), reason: allowance(run) });
    }
  }
  return judged;
}

/**
 * The match between `here` at `start` and `there`, grown both ways for as long
 * as the lines agree. A mark in `ids` agrees with nothing, so a run stops at a
 * block a directive this branch wrote marks: backwards it would start the run
 * a line early, on a closing brace shared by what came before both places, and
 * leave the directive on no line of it; forwards it would fold the next block,
 * kept or not, into this one.
 */
function extended(here: Source, start: number, there: Place): Clone {
  const a = here.ids;
  const b = there.source.ids;
  let back = 0;
  while (
    start - back > 0 &&
    there.start - back > 0 &&
    a[start - back - 1] === b[there.start - back - 1]
  ) {
    back += 1;
  }
  let length = back + WINDOW;
  while (
    start - back + length < a.length &&
    there.start - back + length < b.length &&
    a[start - back + length] === b[there.start - back + length]
  ) {
    length += 1;
  }
  return {
    here: { source: here, start: start - back },
    there: { source: there.source, start: there.start - back },
    length,
  };
}

/**
 * The clone as it is reported, with what it covers marked. Against another
 * file that is the run in this one. Against this file it is both ranges, and
 * where they overlap — a block repeating itself, rows of a table — the whole
 * stretch they span, which repeats with the distance between them as its
 * period: two places in one file are two places only where they do not
 * overlap. The stretch is reported as two neighbouring periods, one of them
 * holding the first line in it this branch wrote, since the rows before that
 * line may be ones it never touched.
 */
function reportedAs(run: Clone, cover: Uint8Array): Clone {
  const { here, there, length } = run;
  if (here.source !== there.source) {
    cover.fill(1, here.start, here.start + length);
    return run;
  }
  const period = Math.abs(there.start - here.start);
  if (length <= period) {
    cover.fill(1, here.start, here.start + length);
    cover.fill(1, there.start, there.start + length);
    return run;
  }
  const from = Math.min(here.start, there.start);
  const end = from + period + length;
  cover.fill(1, from, end);
  const source = here.source;
  const written = source.at.findIndex(
    (line, index) => index >= from && index < end && source.written.has(line),
  );
  // Periods counted from the stretch's start; past its last whole period, the
  // last two that fit end where the stretch does.
  const row = from + period * Math.floor((written - from) / period);
  const first =
    row + 2 * period <= end ? row : row + period <= end ? row - period : end - 2 * period;
  const [own, other] = written < first + period ? [first, first + period] : [first + period, first];
  return { here: { source, start: own }, there: { source, start: other }, length: period };
}

function lineAt(source: Source, index: number): number {
  const line = source.at[index];
  if (line === undefined) {
    throw new Error(`${source.file} has no normalised line ${index}, which a clone was found on`);
  }
  return line;
}

/**
 * The clones with the second report of each pair dropped: two changed files
 * sharing a run are found from both ends.
 */
function uniquePairs(judged: readonly Judged[]): Judged[] {
  const seen = new Set<string>();
  return judged.filter(({ clone: { here, there } }) => {
    const key = [here, there]
      .map(({ source, start }) => `${source.file}\0${start}`)
      .toSorted()
      .join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function located({ source, start }: Place, length: number): string {
  return `${source.file}:${lineAt(source, start)}-${lineAt(source, start + length - 1)}`;
}

function describe({ here, there, length }: Clone): string {
  return `${located(here, length)} repeats ${located(there, length)} (${length} normalised lines)`;
}

/**
 * The reason a run is kept, or nothing where it is not. A run stops at a mark
 * and a mark stands only before a block whose directive this branch wrote, so
 * a run is kept exactly where one of its places starts right after one: a
 * directive somebody wrote on an older block licenses nothing new, even once
 * the branch edits that block.
 *
 * A directive with no reason still keeps the clone here, and the
 * suppression-hygiene gate refuses it: one mistake, one diagnostic.
 */
function allowance({ here, there }: Clone): string | undefined {
  return here.source.kept.get(here.start) ?? there.source.kept.get(there.start);
}

/** A kept clone for the log, escaped as an annotation is: the reason is the repo's text, and stdout is the runner's. */
function keptLine(clone: Clone, reason: string): string {
  const why = reason === "" ? "no reason given, which suppression-hygiene refuses" : reason;
  return commanded(`kept: ${describe(clone)}${REASON}${why}`);
}

function cloneProblem({ here, there, length }: Clone): Problem {
  const from = lineAt(here.source, here.start);
  return {
    file: here.source.file,
    line: from,
    message: `move the ${length} normalised lines ${located(here, length)} shares with ${located(there, length)} into one place both call, or keep the copy with \`// ${KEEP_CLONE}${REASON}<reason>\` on line ${from} or the line above it`,
  };
}
