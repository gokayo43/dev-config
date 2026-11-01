import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { changeSet } from "../_lib/change-set.ts";
import {
  baseRevision,
  commentsBlanked,
  type Event,
  plural,
  type Problem,
  REASON,
  trackedFiles,
  type Verdict,
} from "../_lib/gate.ts";

/**
 * The shortest run of normalised lines that counts as a clone. Not an input: a
 * per-repo number is the first thing a red run asks for, and a floor every repo
 * can move is a floor no repo has. docs/gates/duplicate-code.md says why twelve.
 */
const WINDOW = 12;

/** The extensions source is written in, as pathspecs git narrows a listing by. */
const SOURCE = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

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

/** The directive that keeps a clone, on its first line. */
const DIRECTIVE = /(?:\/\/|\/\*)\s*duplicate-code-allow\b/;

interface Source {
  readonly file: string;
  /** The file's own lines, before normalising, which is where the directive is read. */
  readonly raw: readonly string[];
  readonly lines: readonly Line[];
  /** Each normalised line as a number shared by every line with its text, so a window compares as numbers. */
  readonly ids: readonly number[];
}

interface Window {
  readonly source: Source;
  readonly start: number;
}

/** One side of a clone: a run of normalised lines in one file. */
interface Side {
  readonly source: Source;
  /** Index of the run's first normalised line. */
  readonly start: number;
  /** The line numbers in the file the run starts and ends on. */
  readonly from: number;
  readonly to: number;
}

interface Clone {
  readonly here: Side;
  readonly there: Side;
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
  const base = await baseRevision(root, event, READS_THE_BASE_REF);
  if ("refused" in base) {
    return { note: "the base ref could not be read", problems: [{ message: base.refused }] };
  }
  if (base.rev === undefined) {
    return {
      note: "there is no earlier commit to compare against — nothing this branch wrote to look for",
      problems: [],
    };
  }
  const rev = base.rev;

  const { changed, problems } = await changeSet(root, rev, SOURCE, isGraded);
  if (problems.length > 0) return { note: "a changed file could not be named", problems };
  if (changed.size === 0) {
    return {
      note: `no source file changed against ${rev.slice(0, 12)} — nothing to look for`,
      problems: [],
    };
  }

  const sources = await readSources(root);
  const index = windowIndex(sources);
  const clones = uniquePairs(
    [...changed.keys()].toSorted().flatMap((file) => {
      // A changed file that is not among the sources is a symlink, which is not read.
      const source = sources.get(file);
      return source === undefined ? [] : clonesIn(source, ownLines(source, changed), index);
    }),
  );

  const judged = clones.map((clone) => ({ clone, reason: allowance(clone, changed) }));
  const refused = judged.filter(({ reason }) => reason === undefined).map(({ clone }) => clone);
  const kept = judged.flatMap(({ clone, reason }) =>
    reason === undefined ? [] : [`kept: ${describe(clone)}${REASON}${reason}`],
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
 * Every graded source file, read and normalised. A symlink is skipped rather
 * than followed: its target is either another tracked file, read as itself, or
 * somewhere outside the checkout, which is not this repo's code to grade.
 */
async function readSources(root: string): Promise<Map<string, Source>> {
  const files = (await trackedFiles(root, SOURCE)).filter(isGraded);
  const ids = new Map<string, number>();
  const read = await Promise.all(
    files.map(async (file) => {
      const path = join(root, file);
      if ((await lstat(path)).isSymbolicLink()) return undefined;
      const text = await Bun.file(path).text();
      const lines = normalised(text);
      return {
        file,
        raw: text.split("\n"),
        lines,
        ids: lines.map(({ text: line }) => {
          const known = ids.get(line);
          if (known !== undefined) return known;
          ids.set(line, ids.size);
          return ids.size - 1;
        }),
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

/** Every window of every file, by its text. */
function windowIndex(sources: ReadonlyMap<string, Source>): Map<string, Window[]> {
  const index = new Map<string, Window[]>();
  for (const source of sources.values()) {
    for (let start = 0; start + WINDOW <= source.ids.length; start += 1) {
      const key = keyAt(source.ids, start);
      const found = index.get(key);
      if (found === undefined) index.set(key, [{ source, start }]);
      else found.push({ source, start });
    }
  }
  return index;
}

/** Per normalised line of a changed file, whether this branch wrote it. */
function ownLines(source: Source, changed: ReadonlyMap<string, ReadonlySet<number>>): boolean[] {
  const written = changed.get(source.file);
  return source.lines.map(({ at }) => written?.has(at) === true);
}

/**
 * The clones a changed file's own lines take part in, each extended to the
 * longest run both places share.
 *
 * A run is found once per diagonal — the offset between the two places — and
 * the windows inside a run already found on that diagonal are skipped rather
 * than extended again, which is what keeps a file copied whole linear rather
 * than quadratic in its length.
 */
function clonesIn(
  here: Source,
  own: readonly boolean[],
  index: ReadonlyMap<string, readonly Window[]>,
): Clone[] {
  const clones: Clone[] = [];
  const reached = new Map<string, number>();
  for (let start = 0; start + WINDOW <= here.ids.length; start += 1) {
    if (!own.slice(start, start + WINDOW).includes(true)) continue;
    for (const there of index.get(keyAt(here.ids, start)) ?? []) {
      // Two places in one file are two places only while their ranges stay
      // apart: a block repeating itself within its own run is one block, so a
      // same-file match counts from no closer than a window away and grows no
      // further than the distance between its ends.
      if (there.source === here && Math.abs(there.start - start) < WINDOW) continue;
      const diagonal = `${there.source.file}\0${there.start - start}`;
      if ((reached.get(diagonal) ?? -1) > start) continue;
      const clone = extended(here, start, there);
      reached.set(diagonal, clone.here.start + clone.length);
      clones.push(clone);
    }
  }
  return clones;
}

/** The match between `here` at `start` and `there`, grown both ways for as long as the lines agree. */
function extended(here: Source, start: number, there: Window): Clone {
  const a = here.ids;
  const b = there.source.ids;
  const apart = there.source === here ? Math.abs(there.start - start) : Infinity;
  let back = 0;
  while (
    back + WINDOW < apart &&
    start - back > 0 &&
    there.start - back > 0 &&
    a[start - back - 1] === b[there.start - back - 1]
  ) {
    back += 1;
  }
  let length = back + WINDOW;
  while (
    length < apart &&
    start - back + length < a.length &&
    there.start - back + length < b.length &&
    a[start - back + length] === b[there.start - back + length]
  ) {
    length += 1;
  }
  return {
    here: side(here, start - back, length),
    there: side(there.source, there.start - back, length),
    length,
  };
}

function side(source: Source, start: number, length: number): Side {
  return { source, start, from: lineAt(source, start), to: lineAt(source, start + length - 1) };
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
 * sharing a run, or one file sharing a run with itself, are found from both
 * ends.
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

function located({ source, from, to }: Side): string {
  return `${source.file}:${from}-${to}`;
}

function describe({ here, there, length }: Clone): string {
  return `${located(here)} repeats ${located(there)} (${length} normalised lines)`;
}

/**
 * The reason a clone is kept, or nothing where it is not. The directive counts
 * on the first line of a side this branch wrote into: a directive somebody wrote
 * on an older block does not license the next copy of it.
 *
 * A directive with no reason still keeps the clone here, and the
 * suppression-hygiene gate refuses it: one mistake, one diagnostic.
 */
function allowance(
  { here, there, length }: Clone,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): string | undefined {
  for (const { source, start, from } of [here, there]) {
    const written = changed.get(source.file);
    const ownsALine = source.lines
      .slice(start, start + length)
      .some(({ at }) => written?.has(at) === true);
    const line = source.raw[from - 1] ?? "";
    if (!ownsALine || !DIRECTIVE.test(line)) continue;
    const [, ...reason] = line.split(REASON);
    const why = reason.join(REASON).trim();
    return why === "" ? "(no reason given, which suppression-hygiene refuses)" : why;
  }
  return undefined;
}

function cloneProblem({ here, there, length }: Clone): Problem {
  return {
    file: here.source.file,
    line: here.from,
    message: `move the ${length} normalised lines ${located(here)} shares with ${located(there)} into one place both call, or keep the copy with \`// duplicate-code-allow${REASON}<reason>\` on line ${here.from}`,
  };
}
