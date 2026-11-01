import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { branchChange } from "../_lib/change-set.ts";
import { commentsBlanked } from "../_lib/comments.ts";
import {
  commanded,
  type Event,
  git,
  KEEP_CLONE,
  plural,
  type Problem,
  REASON,
  reasonAfter,
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
  readonly lines: readonly Line[];
  /** Each normalised line as a number shared by every line with its text, so a window compares as numbers. */
  readonly ids: readonly number[];
  /** The reason each directive in the file gives, by the line it is written on. */
  readonly directives: ReadonlyMap<number, string>;
  /** The lines this branch wrote, by number — none, for a file it did not change. */
  readonly written: ReadonlySet<number>;
  /** The line of the directive marking a block that starts at a normalised line, by that line's index. */
  readonly keptBy: ReadonlyMap<number, number>;
  /** How many normalised lines before each index start a block a directive marks, so a range is asked in one subtraction. */
  readonly marked: readonly number[];
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
  const listed = (await trackedFiles(root, SOURCE)).filter(isGraded);
  const generated = await generatedAmong(root, listed);
  const change = await branchChange(root, event, {
    why: READS_THE_BASE_REF,
    pathspecs: SOURCE,
    keeps: (path) => isGraded(path) && !generated.has(path),
    noun: "source file",
    nothing: "nothing to look for",
  });
  if ("problems" in change) return change;
  const { changed } = change;

  const sources = await readSources(
    root,
    listed.filter((file) => !generated.has(file)),
    changed,
  );
  const index = windowIndex(sources);
  const clones = uniquePairs(
    [...changed.keys()].toSorted().flatMap((file) => {
      // A changed file that is not among the sources is a tracked symlink, which is not read.
      const source = sources.get(file);
      return source === undefined ? [] : clonesIn(source, index);
    }),
  );

  const judged = clones.map((clone) => ({ clone, reason: allowance(clone) }));
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
 * The marking that counts is the one the repo commits, for the reason
 * `_lib/change-set.ts` pins its diff settings: a gate whose answer depends on
 * the reader's config has no answer. So the question goes to an empty git
 * directory borrowing this repo's objects, asked of the committed tree: that
 * reads the tree's `.gitattributes` and neither the checkout's
 * `info/attributes` nor, with the pin, the reader's own attributes file. A repo
 * with no commit yet has no committed marking.
 */
async function generatedAmong(root: string, files: readonly string[]): Promise<Set<string>> {
  const tree = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  if (!tree.ok) return new Set();
  const [common, prefix] = await Promise.all([
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["rev-parse", "--show-prefix"]),
  ]);
  if (!common.ok || !prefix.ok) throw new Error(`git cannot name the repository at ${root}`);
  const under = prefix.stdout.trim();

  const scratch = await mkdtemp(join(tmpdir(), "duplicate-code-"));
  try {
    if (!(await git(scratch, ["init", "--quiet", "--bare"])).ok) {
      throw new Error(`git could not make a scratch repository in ${scratch}`);
    }
    await Bun.write(
      join(scratch, "objects", "info", "alternates"),
      `${common.stdout.trim()}/objects\n`,
    );
    const answered = await git(
      scratch,
      [
        "-c",
        "core.attributesFile=/dev/null",
        "check-attr",
        `--source=${tree.stdout.trim()}`,
        "-z",
        "--stdin",
        "linguist-generated",
      ],
      files.map((file) => `${under}${file}\0`).join(""),
    );
    if (!answered.ok) throw new Error(`git check-attr failed for ${root}`);
    // `-z` answers path, attribute and value per file, each ended by a NUL. A
    // value of `set` is the bare attribute and `true` is `=true`; `unset`,
    // `false` and `unspecified` are a file nobody marked.
    const fields = answered.stdout.split("\0");
    const generated = new Set<string>();
    for (let at = 0; at + 2 < fields.length; at += 3) {
      const value = fields[at + 2];
      if (value === "set" || value === "true")
        generated.add((fields[at] ?? "").slice(under.length));
    }
    return generated;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
  const ids = new Map<string, number>();
  const read = await Promise.all(
    files.map(async (file): Promise<Source | undefined> => {
      const path = join(root, file);
      if ((await lstat(path)).isSymbolicLink()) return undefined;
      const text = await Bun.file(path).text();
      const lines = normalised(text);
      const directives = new Map(
        text
          .split("\n")
          .flatMap((line, index): [number, string][] =>
            DIRECTIVE.test(line) ? [[index + 1, reasonAfter(line)]] : [],
          ),
      );
      const keptBy = new Map(
        lines.flatMap(({ at }, index): [number, number][] => {
          const line = directiveLineFor(at, directives, lines[index - 1]?.at);
          return line === undefined ? [] : [[index, line]];
        }),
      );
      let count = 0;
      const marked = [0, ...lines.map((_, index) => (count += keptBy.has(index) ? 1 : 0))];
      return {
        file,
        lines,
        ids: lines.map(({ text: line }) => {
          const known = ids.get(line);
          if (known !== undefined) return known;
          ids.set(line, ids.size);
          return ids.size - 1;
        }),
        directives,
        written: changed.get(file) ?? new Set(),
        keptBy,
        marked,
      };
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

/** Whether a directive marks a block starting at any of `from` up to, not including, `to`. */
function marksIn(source: Source, from: number, to: number): boolean {
  return (source.marked[to] ?? 0) - (source.marked[from] ?? 0) > 0;
}

/**
 * The line carrying the directive that marks a block starting on line `at`: the
 * line itself, or the line directly above it where that line is a comment of
 * its own — the shape every other directive here takes. A directive trailing
 * the code above belongs to that line's block, not to this one.
 */
function directiveLineFor(
  at: number,
  directives: ReadonlyMap<number, string>,
  previous: number | undefined,
): number | undefined {
  if (directives.has(at)) return at;
  return directives.has(at - 1) && previous !== at - 1 ? at - 1 : undefined;
}

/**
 * The clones a changed file's own lines take part in, each extended to the
 * longest run both places share.
 *
 * Each normalised line of the file takes part in at most one reported clone
 * with any one other file, and in at most one with itself: once a run is
 * reported, a window starting inside it is not matched against that file
 * again. That is what reports a block once however often it is repeated, and
 * what keeps the work linear in the file — a window inside a reported run
 * costs one lookup, not a fresh extension.
 */
function clonesIn(
  here: Source,
  index: ReadonlyMap<string, ReadonlyMap<Source, readonly number[]>>,
): Clone[] {
  const own = here.lines.map(({ at }) => here.written.has(at));
  const covers = new Map<Source, Uint8Array>();
  const coverFor = (source: Source): Uint8Array => {
    const found = covers.get(source) ?? new Uint8Array(here.ids.length);
    covers.set(source, found);
    return found;
  };
  const clones: Clone[] = [];
  for (let start = 0; start + WINDOW <= here.ids.length; start += 1) {
    if (!own.slice(start, start + WINDOW).includes(true)) continue;
    if (marksIn(here, start + 1, start + WINDOW)) continue;
    for (const [source, starts] of index.get(keyAt(here.ids, start)) ?? []) {
      const cover = coverFor(source);
      if (cover[start] === 1) continue;
      const at = starts.find(
        (each) =>
          !marksIn(source, each + 1, each + WINDOW) &&
          (source !== here || (Math.abs(each - start) >= WINDOW && cover[each] !== 1)),
      );
      if (at === undefined) continue;
      const clone = extended(here, start, { source, start: at });
      clones.push(reportedAs(clone, cover));
    }
  }
  return clones;
}

/**
 * The match between `here` at `start` and `there`, grown both ways for as long
 * as the lines agree. A line a directive marks is where a block starts, so a
 * run never grows across one: backwards it would start the run a line early,
 * on a closing brace shared by what came before both places, and leave the
 * directive on no line of it; forwards it would fold the next block, kept or
 * not, into this one. A window with such a line inside it is skipped in
 * `clonesIn` for the same reason, and the run is found from that line instead.
 */
function extended(here: Source, start: number, there: Place): Clone {
  const a = here.ids;
  const b = there.source.ids;
  let back = 0;
  while (
    start - back > 0 &&
    there.start - back > 0 &&
    !marksIn(here, start - back, start - back + 1) &&
    !marksIn(there.source, there.start - back, there.start - back + 1) &&
    a[start - back - 1] === b[there.start - back - 1]
  ) {
    back += 1;
  }
  let length = back + WINDOW;
  while (
    !marksIn(here, start - back + length, start - back + length + 1) &&
    !marksIn(there.source, there.start - back + length, there.start - back + length + 1) &&
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
 * stretch they span, reported as its first two periods side by side: two places
 * in one file are two places only where they do not overlap.
 */
function reportedAs(clone: Clone, cover: Uint8Array): Clone {
  const { here, there, length } = clone;
  if (here.source !== there.source) {
    cover.fill(1, here.start, here.start + length);
    return clone;
  }
  const apart = Math.abs(there.start - here.start);
  const from = Math.min(here.start, there.start);
  if (length > apart) {
    cover.fill(1, from, from + apart + length);
    return { here, there, length: apart };
  }
  cover.fill(1, here.start, here.start + length);
  cover.fill(1, there.start, there.start + length);
  return clone;
}

function lineAt(source: Source, index: number): number {
  const line = source.lines[index];
  if (line === undefined) {
    throw new Error(`${source.file} has no normalised line ${index}, which a clone was found on`);
  }
  return line.at;
}

/**
 * The clones with the second report of each pair dropped: two changed files
 * sharing a run are found from both ends.
 */
function uniquePairs(clones: readonly Clone[]): Clone[] {
  const seen = new Set<string>();
  return clones.filter(({ here, there }) => {
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
 * The reason a clone is kept, or nothing where it is not: the directive counts
 * only where this branch wrote the line it is on. A directive somebody wrote on
 * an older block licenses nothing new, even once the branch edits that block.
 *
 * A directive with no reason still keeps the clone here, and the
 * suppression-hygiene gate refuses it: one mistake, one diagnostic.
 */
function allowance({ here, there }: Clone): string | undefined {
  for (const place of [here, there]) {
    const line = place.source.keptBy.get(place.start);
    if (line !== undefined && place.source.written.has(line)) {
      return place.source.directives.get(line);
    }
  }
  return undefined;
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
