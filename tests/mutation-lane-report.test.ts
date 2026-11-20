import { expect, test } from "bun:test";
import {
  type Arbitrary,
  array,
  boolean,
  constant,
  constantFrom,
  double,
  integer,
  nat,
  oneof,
  option,
  property,
  record,
  subarray,
  uniqueArray,
} from "fast-check";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import { verdict } from "../.github/actions/mutation-lane/report.ts";
import type { Tests } from "../.github/actions/mutation-lane/tests.ts";
import { must } from "../narrowing.ts";
import { check } from "../property.ts";

/**
 * Small pools, so that two mutants differing in exactly one field are common.
 * Two files differ in case alone, where code unit order and a collation
 * disagree, and one line has two digits, where an order by text and an order
 * by number disagree.
 */
const FILES = ["src/b.ts", "src/B.ts", "src/a.ts"];
const MUTATORS = ["ConditionalExpression", "EqualityOperator"];
const REPLACEMENTS = ["true", "false", "a <= 0"];
const STATUSES = [
  "Killed",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Timeout",
  "Ignored",
  "Pending",
];
/** The three statuses a mutant on a line the branch wrote is listed under. */
const LISTED = ["Survived", "NoCoverage", "Ignored"];
const LINES = Array.from({ length: 12 }, (_, index) => index + 1);

/** A mutant as Stryker's report holds it, with its place in the shuffled report. */
interface Mutant {
  readonly rank: number;
  readonly from: number;
  readonly span: number;
  readonly mutatorName: string;
  readonly replacement: string;
  readonly status: string;
  readonly static: boolean;
}

/** One file of a generated report, with its place in the shuffled one and the lines the branch wrote in it. */
interface ReportFile {
  readonly name: string;
  readonly rank: number;
  readonly mutants: readonly Mutant[];
  readonly wrote: readonly number[];
}

/**
 * Every line a mutant can start on is in `LINES`, and so is every line it can
 * end on, so a file whose branch wrote all of `LINES` owns all its mutants.
 */
function mutantOf(status: Arbitrary<string>): Arbitrary<Mutant> {
  return record({
    rank: nat(),
    from: constantFrom(1, 2, 10),
    span: integer({ min: 0, max: 1 }),
    mutatorName: constantFrom(...MUTATORS),
    replacement: constantFrom(...REPLACEMENTS),
    status,
    static: boolean(),
  });
}

function reportOf(
  mutant: Arbitrary<Mutant>,
  wrote: Arbitrary<readonly number[]>,
): Arbitrary<ReportFile[]> {
  return uniqueArray(
    record({
      name: constantFrom(...FILES),
      rank: nat(),
      mutants: array(mutant, { maxLength: 8 }),
      wrote,
    }),
    { selector: (each) => each.name, maxLength: FILES.length },
  );
}

/**
 * Every status the report schema names, weighted toward the three that list a
 * finding, since a report holding a non-static `RuntimeError` or `Pending` is
 * refused before anything is listed; and lines written as every line or any
 * subset of them, so some mutants are the branch's own and some are not.
 */
const anyReport = reportOf(
  mutantOf(
    oneof(
      { arbitrary: constantFrom(...LISTED), weight: 4 },
      { arbitrary: constantFrom(...STATUSES), weight: 1 },
    ),
  ),
  oneof({ arbitrary: constant(LINES), weight: 3 }, { arbitrary: subarray(LINES), weight: 1 }),
);

/** A report every mutant of which is listed: a listed status, on lines the branch wrote. */
const listedReport = reportOf(mutantOf(constantFrom(...LISTED)), constant(LINES));

const tests = constantFrom<Tests>(
  { kind: "walked" },
  { kind: "named", files: ["tests/a.test.ts"] },
);

/** The report's text, as Stryker would write it with its files and mutants in this order. */
function text(files: readonly ReportFile[]): string {
  return JSON.stringify({
    files: Object.fromEntries(
      files.map(({ name, mutants }) => [
        name,
        {
          mutants: mutants.map(
            ({ from, span, mutatorName, replacement, status, static: atLoad }) => ({
              location: {
                start: { line: from, column: 1 },
                end: { line: from + span, column: 2 },
              },
              mutatorName,
              replacement,
              status,
              static: atLoad,
            }),
          ),
        },
      ]),
    ),
  });
}

/** The same files and mutants in the order their ranks give, which is any order. */
function shuffled(files: readonly ReportFile[]): ReportFile[] {
  return files
    .toSorted((a, b) => a.rank - b.rank)
    .map((file) => ({
      ...file,
      mutants: file.mutants.toSorted((a, b) => a.rank - b.rank),
    }));
}

function changedIn(files: readonly ReportFile[]): Map<string, Set<number>> {
  return new Map(files.map(({ name, wrote }) => [name, new Set(wrote)]));
}

/**
 * Code unit order, as the gate's page states it. The model's own rather than
 * the gate's `byCodeUnit`, so a wrong order there cannot pass both.
 */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * What a reader can see of one listed finding: file, first line, mutator,
 * replacement and status, the fields its summary line prints. The last line is
 * printed nowhere, so it decides only where a finding sits.
 */
type Seen = readonly [
  file: string,
  line: number,
  mutator: string,
  replacement: string,
  status: string,
];

const SUMMARY_LINE = /^- `([^`]+):(\d+)` (\S+) → `([^`]*)` \((\w+)\)$/u;

/** A report holding no mutant has no score, and so no table. */
function summaryLines({ table = "" }: Verdict): Seen[] {
  return table.split("\n").flatMap((line) => {
    const found = SUMMARY_LINE.exec(line);
    return found === null
      ? []
      : [
          [
            must(found[1]),
            Number(found[2]),
            must(found[3]),
            must(found[4]),
            must(found[5]),
          ] as const,
        ];
  });
}

/** The file, line, replacement and mutator of every problem naming a mutant, in the order the step prints them. */
function problemsSeen({ problems }: Verdict): (readonly [string, number, string, string])[] {
  return problems.flatMap(({ file, message }) => {
    if (file === undefined) return [];
    const line = must(/line (\d+)/u.exec(message));
    const swap = must(/`([^`]*)` \((\w+)\)/u.exec(message));
    return [[file, Number(line[1]), must(swap[1]), must(swap[2])] as const];
  });
}

// The listing is a function of the set of findings: the same report with its
// files and each file's mutants in another order gives the same verdict,
// problems, table and note alike. Kills a listing in the report's order, which
// Stryker sets by when each mutant finished, and a sort by a key that leaves
// out a field the output shows, which ties two mutants differing only in that
// field and lists them in the report's order. The last assertion, that the
// floor's problem comes after every finding, kills one put anywhere else.
test("the findings are listed in one order whatever order the report holds them in", () => {
  check(
    property(
      anyReport,
      option(double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
      tests,
      (files, bound, run) => {
        const changed = changedIn(files);
        const listed = verdict(text(files), changed, bound, run, "log");

        expect(verdict(text(shuffled(files)), changed, bound, run, "log")).toEqual(listed);
        expect(listed.problems.slice(0, -1).filter(({ file }) => file === undefined)).toEqual([]);
      },
    ),
  );
});

// The order the gate's page states: by file, first line, last line, mutator,
// replacement and status, text by code unit. The model sorts the generated
// mutants by that key, and the step's summary lines and its problems must both
// follow it. Kills an order that leaves out the last line, which no output
// shows and so the property above cannot see; one that compares the fields in
// another priority; one that collates text where code units decide (`src/B.ts`
// before `src/a.ts`); and one that compares lines as text (`10` before `2`).
test("the findings are listed by file, first line, last line, mutator, replacement and status", () => {
  check(
    property(listedReport, tests, (files, run) => {
      const listed = verdict(text(files), changedIn(files), undefined, run, "log");

      const expected = files
        .flatMap(({ name, mutants }) => mutants.map((mutant) => ({ name, ...mutant })))
        .toSorted(
          (a, b) =>
            byCodeUnit(a.name, b.name) ||
            a.from - b.from ||
            a.span - b.span ||
            byCodeUnit(a.mutatorName, b.mutatorName) ||
            byCodeUnit(a.replacement, b.replacement) ||
            byCodeUnit(a.status, b.status),
        );
      expect(summaryLines(listed)).toEqual(
        expected.map(({ name, from, mutatorName, replacement, status }) => [
          name,
          from,
          mutatorName,
          replacement,
          status,
        ]),
      );
      expect(problemsSeen(listed)).toEqual(
        expected.map(({ name, from, mutatorName, replacement }) => [
          name,
          from,
          replacement,
          mutatorName,
        ]),
      );
    }),
  );
});
