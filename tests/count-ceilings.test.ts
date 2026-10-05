/**
 * The ceiling rule the count budget's write and check share, as properties over
 * generated entries and measures. The browser suite drives the same rule end to
 * end; this is where its invariants are searched.
 */
import { describe, expect, test } from "bun:test";
import {
  array,
  constantFrom,
  integer,
  nat,
  oneof,
  option,
  property,
  record as shaped,
  string,
  tuple,
  uniqueArray,
} from "fast-check";

import {
  type Ceiling,
  ceilingOf,
  type Count,
  COUNTS,
  type Counts,
  described,
  type Entry,
  entryAt,
  entryIn,
  entryJson,
  isBroken,
  isRaised,
  lowered,
  type Measured,
  withEntry,
} from "../count-ceilings.ts";
import { check } from "../property.ts";

const BROWSER = "chromium 151.0.7922.34";

/** Phase names, the ones every object already has among them. */
const phaseName = oneof(
  constantFrom("load", "sort", "constructor", "__proto__", "toString", "ärlig"),
  string({ minLength: 1, maxLength: 6 }),
);

const counts = shaped(
  {
    reactCommits: option(nat(40), { nil: undefined }),
    mutationRecords: nat(400),
    requests: nat(40),
    bodyBytes: nat(5_000),
    scriptBytes: nat(5_000),
  },
  { noNullPrototype: true },
).map((each): Counts => {
  const { reactCommits, ...rest } = each;
  return reactCommits === undefined ? rest : { reactCommits, ...rest };
});

const measuredOf = uniqueArray(tuple(phaseName, counts), {
  minLength: 1,
  maxLength: 4,
  selector: ([phase]) => phase,
}).map((phases): Measured => new Map(phases));

/** Replaces some of an entry's plain ceilings with raises above them, as a person writes one. */
function raised(entry: Entry, raises: readonly number[]): Entry {
  let index = 0;
  const phases = new Map(
    [...entry.phases].map(([phase, held]) => [
      phase,
      new Map(
        [...held].map(([count, ceiling]): [Count, Ceiling] => {
          const by = raises[index++ % Math.max(raises.length, 1)] ?? 0;
          if (by === 0 || isRaised(ceiling)) return [count, ceiling];
          return [
            count,
            { ceiling: ceiling + by, was: ceiling, reason: "the page now shows more" },
          ];
        }),
      ),
    ]),
  );
  return { ...entry, phases };
}

/** The measure that meets every ceiling of an entry exactly. */
function meeting(entry: Entry): Measured {
  return new Map(
    [...entry.phases].map(([phase, held]) => [
      phase,
      Object.fromEntries([...held].map(([count, ceiling]) => [count, ceilingOf(ceiling)])),
    ]),
  );
}

/**
 * An entry the command could have left, then raised by hand: from a first
 * measure, with some counts raised and, sometimes, those raises kept by a run
 * that met them.
 */
const entryOf = tuple(
  measuredOf,
  array(integer({ min: 0, max: 3 }), { maxLength: 8 }),
  constantFrom(false, true),
).map(([first, raises, kept]) => {
  const written = raised(lowered(undefined, first, BROWSER).entry, raises);
  return kept ? lowered(written, meeting(written), BROWSER).entry : written;
});

/**
 * A measure that shares phases with an entry and moves their counts either way:
 * as they are, with fresh phases beside them, without the first of them, or
 * with React commits counted where they were not and not where they were.
 */
const nextMeasure = (entry: Entry) =>
  tuple(
    measuredOf,
    array(integer({ min: -3, max: 3 }), { maxLength: 30 }),
    constantFrom("shifted", "beside fresh", "one dropped", "react toggled"),
  ).map(([fresh, shifts, shape]): Measured => {
    let index = 0;
    const shifted = [...entry.phases].map(([phase, held]): [string, Counts] => [
      phase,
      Object.fromEntries(
        [...held].map(([count, ceiling]) => [
          count,
          Math.max(0, ceilingOf(ceiling) + (shifts[index++] ?? 0)),
        ]),
      ),
    ]);
    if (shape === "shifted") return new Map(shifted);
    if (shape === "beside fresh") return new Map([...shifted, ...fresh]);
    if (shape === "one dropped") return new Map([...shifted.slice(1), ...fresh]);
    return new Map(
      shifted.map(([phase, { reactCommits, ...rest }]) => [
        phase,
        reactCommits === undefined ? { reactCommits: 0, ...rest } : rest,
      ]),
    );
  });

const entryAndMeasure = entryOf.chain((entry) => tuple(constantFrom(entry), nextMeasure(entry)));

function ceilingAt(entry: Entry, phase: string, count: Count): Ceiling | undefined {
  return entry.phases.get(phase)?.get(count);
}

describe("the command", () => {
  test("never raises a ceiling", () => {
    check(
      property(entryAndMeasure, ([entry, measured]) => {
        const next = lowered(entry, measured, BROWSER).entry;
        for (const [phase, held] of next.phases) {
          for (const [count, ceiling] of held) {
            const before = ceilingAt(entry, phase, count);
            if (before !== undefined)
              expect(ceilingOf(ceiling)).toBeLessThanOrEqual(ceilingOf(before));
          }
        }
      }),
    );
  });

  test("writes the lower of each ceiling and its measure, and the measure where there was no ceiling", () => {
    check(
      property(entryAndMeasure, ([entry, measured]) => {
        const next = lowered(entry, measured, BROWSER).entry;
        expect([...next.phases.keys()]).toEqual([...measured.keys()]);
        for (const [phase, held] of measured) {
          for (const count of COUNTS) {
            const value = held[count];
            const before = ceilingAt(entry, phase, count);
            const after = ceilingAt(next, phase, count);
            if (value === undefined) {
              expect(after).toBeUndefined();
            } else {
              expect(ceilingOf(after ?? Number.NaN)).toBe(
                before === undefined ? value : Math.min(value, ceilingOf(before)),
              );
            }
          }
        }
      }),
    );
  });

  test("leaves what it writes intact under its seal", () => {
    check(
      property(entryAndMeasure, ([entry, measured]) => {
        expect(isBroken(lowered(entry, measured, BROWSER).entry)).toBe(false);
      }),
    );
  });
});

describe("the check", () => {
  // A check fails on every change the command lists. Each one but a count above
  // its ceiling is a difference in what the command writes; that one is a
  // ceiling the command keeps and fails on.
  test("lists a change for exactly the ways the written entry differs, beside counts above their ceilings", () => {
    check(
      property(entryAndMeasure, ([entry, measured]) => {
        const { entry: next, changes } = lowered(entry, measured, BROWSER);
        const differences = changes.filter(({ kind }) => kind !== "above");
        expect(differences.length === 0).toBe(Bun.deepEquals(entryJson(next), entryJson(entry)));
        for (const change of changes) {
          if (change.kind !== "above") continue;
          expect(ceilingAt(next, change.phase, change.count)).toEqual(change.ceiling);
          expect(change.measured).toBeGreaterThan(ceilingOf(change.ceiling));
        }
      }),
    );
  });

  test("passes only when every count equals its ceiling", () => {
    check(
      property(entryAndMeasure, ([entry, measured]) => {
        if (lowered(entry, measured, BROWSER).changes.length > 0) return;
        expect([...measured.keys()].toSorted()).toEqual([...entry.phases.keys()].toSorted());
        for (const [phase, held] of measured) {
          for (const count of COUNTS) {
            const value = held[count];
            const ceiling = ceilingAt(entry, phase, count);
            expect(value).toBe(ceiling === undefined ? undefined : ceilingOf(ceiling));
          }
        }
      }),
    );
  });

  test("fails a raise the command has not kept, and passes once it has", () => {
    check(
      property(measuredOf, integer({ min: 1, max: 5 }), (first, by) => {
        const fresh = raised(lowered(undefined, first, BROWSER).entry, [by]);
        const measure = meeting(fresh);
        const { entry: kept, changes } = lowered(fresh, measure, BROWSER);
        expect(changes.map(({ kind }) => kind)).toContain("raise kept");
        expect(lowered(kept, measure, BROWSER).changes).toEqual([]);
      }),
    );
  });
});

describe("the seal", () => {
  /** The entry with its first plain count, or its first raise's ceiling, moved up by `by`. */
  const editedInPlace = (entry: Entry, by: number, raise: boolean): Entry | undefined => {
    for (const [phase, held] of entry.phases) {
      for (const [count, ceiling] of held) {
        if (isRaised(ceiling) !== raise) continue;
        const moved: Ceiling = isRaised(ceiling)
          ? { ...ceiling, ceiling: ceiling.ceiling + by }
          : ceiling + by;
        const phases = new Map(entry.phases);
        phases.set(phase, new Map(held).set(count, moved));
        return { ...entry, phases };
      }
    }
    return undefined;
  };

  test("survives a raise a person writes in the form", () => {
    check(
      property(measuredOf, integer({ min: 1, max: 5 }), (first, by) => {
        expect(isBroken(raised(lowered(undefined, first, BROWSER).entry, [by]))).toBe(false);
      }),
    );
  });

  test("breaks on a plain ceiling edited in place", () => {
    check(
      property(entryOf, integer({ min: 1, max: 9 }), (entry, by) => {
        const edited = editedInPlace(entry, by, false);
        if (edited !== undefined) expect(isBroken(edited)).toBe(true);
      }),
    );
  });

  test("breaks on a kept raise raised again in place", () => {
    check(
      property(
        measuredOf,
        integer({ min: 1, max: 5 }),
        integer({ min: 1, max: 9 }),
        (first, by, again) => {
          const fresh = raised(lowered(undefined, first, BROWSER).entry, [by]);
          const kept = lowered(fresh, meeting(fresh), BROWSER).entry;
          const edited = editedInPlace(kept, again, true);
          expect(edited).toBeDefined();
          if (edited !== undefined) expect(isBroken(edited)).toBe(true);
        },
      ),
    );
  });
});

describe("the file", () => {
  test("holds an entry under a key every object already has, and reads it back", () => {
    check(
      property(
        measuredOf,
        constantFrom("__proto__", "constructor", "toString"),
        (measured, key) => {
          const entry = lowered(undefined, measured, BROWSER).entry;
          const file: unknown = JSON.parse(JSON.stringify(withEntry({}, key, entry)));
          if (typeof file !== "object" || file === null)
            throw new Error("the file is not an object");
          expect(Object.keys(file)).toEqual([key]);
          expect(entryIn(Object.fromEntries(Object.entries(file)), key, key)).toEqual(entry);
          expect(entryIn({}, key, key)).toBeUndefined();
        },
      ),
    );
  });
});

describe("reading an entry", () => {
  test("reads back every entry the command writes, raises included", () => {
    check(
      property(entryOf, (entry) => {
        const file: unknown = JSON.parse(JSON.stringify(withEntry({}, "a test", entry)));
        if (typeof file !== "object" || file === null) throw new Error("the file is not an object");
        expect(entryIn(Object.fromEntries(Object.entries(file)), "a test", "a test")).toEqual(
          entry,
        );
      }),
    );
  });

  const written = (phases: unknown) => ({ browser: BROWSER, phases, seal: "" });

  test.each([
    ["a fraction", written({ load: { requests: 1.5 } }), "is 1.5, and a ceiling is a whole number"],
    [
      "a negative number",
      written({ load: { requests: -1 } }),
      "is -1, and a ceiling is a whole number",
    ],
    [
      "a raise with no reason",
      written({ load: { requests: { ceiling: 5, was: 3, reason: " " } } }),
      "is raised from 3 to 5 with no reason",
    ],
    [
      "a raise that is not above what it was",
      written({ load: { requests: { ceiling: 3, was: 3, reason: "why" } } }),
      "its ceiling 3 is not above the 3 the command accepted",
    ],
    [
      "a raise with no number in it",
      written({ load: { requests: { ceiling: "5", was: 3, reason: "why" } } }),
      "is neither a whole number nor a raised ceiling",
    ],
    ["a count that is not one", written({ load: { paints: 1 } }), "load.paints is not a count"],
    ["phases that are not an object", written([]), ".phases is not a JSON object"],
    ["no browser", { phases: {}, seal: "" }, ".browser is not a string"],
    ["no seal", { browser: BROWSER, phases: {} }, ".seal is not a string"],
  ])("refuses %s, naming where it is", (_, value, said) => {
    expect(() => entryAt(value, "the file › a test")).toThrow(said);
  });
});

describe("what a change says", () => {
  const where = { key: "a test", spec: "e2e/a.spec.ts", ceilings: "e2e/a.spec.counts.json" };

  test("names the file, and the command wherever the command is the remedy", () => {
    check(
      property(
        entryAndMeasure,
        constantFrom(BROWSER, "chromium 1.0.0.0"),
        ([entry, measured], browser) => {
          const changes = [
            ...lowered(undefined, measured, BROWSER).changes,
            ...lowered(entry, measured, browser).changes,
          ];
          for (const change of changes) {
            const said = described(change, where);
            expect(said).toContain(where.ceilings);
            if (change.kind !== "above")
              expect(said).toContain("COUNT_BUDGET=write bunx playwright test e2e/a.spec.ts");
            if ("phase" in change) expect(said).toContain(`«${change.phase}»`);
            if (change.kind === "above") {
              expect(said).toContain(
                `measured ${change.measured}, ceiling ${ceilingOf(change.ceiling)}`,
              );
              expect(said).toContain(`{ "ceiling": ${change.measured}, "was": `);
            }
          }
        },
      ),
    );
  });
});
