import { describe, expect, test } from "bun:test";
import { anything, array, constantFrom, double, integer, oneof, property } from "fast-check";

import { must, nth, only, rejectionOf } from "../narrowing.ts";
import { check } from "../property.ts";

/** What a call threw, so a case can read the message it owes. */
function thrown(call: () => void): string {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw new Error(`threw something that is not an Error: ${String(error)}`, { cause: error });
  }
  throw new Error("returned where it had to throw");
}

/** A rejection class the cases below can tell apart from every built-in one. */
class Refused extends Error {}
class RefusedHarder extends Refused {}

/** An index of any kind a caller can write: in range, past the end, negative or fractional. */
const indices = oneof(
  integer({ min: -5, max: 20 }),
  integer({ min: -2, max: 10 }).map((whole) => whole + 0.5),
  double({ noNaN: true }),
  constantFrom(Number.NaN),
);

describe("nth", () => {
  // Model agreement with the language's own definition of "the list holds an
  // element there". Kills a bounds check that is off by one at either end, one
  // that admits a negative index the way `at` does, and one that floors a
  // fractional index.
  test("returns the element at an index the list holds, and throws at every other", () => {
    check(
      property(array(anything()), indices, (list, index) => {
        if (Number.isInteger(index) && index >= 0 && index < list.length) {
          expect(Object.is(nth(list, index), list[index])).toBe(true);
        } else {
          expect(thrown(() => nth(list, index))).toBe(
            `nth: expected an element at index ${index}, found a list of length ${list.length}`,
          );
        }
      }),
    );
  });

  // The case a `?.` turns green: an element that is itself `undefined` is
  // still an element, and an index past the end is not, however alike the two
  // read back.
  test("an undefined element is returned, not refused", () => {
    expect(nth([undefined], 0)).toBeUndefined();
    expect(thrown(() => nth([undefined], 1))).toContain("found a list of length 1");
  });
});

describe("only", () => {
  // Kills an `only` that returns the first of several, which is the wrong
  // implementation `rows[0]` already is.
  test("returns the one element of a one-element list, and throws for every other length", () => {
    check(
      property(array(anything()), (list) => {
        if (list.length === 1) {
          expect(Object.is(only(list), list[0])).toBe(true);
        } else {
          expect(thrown(() => only(list))).toBe(
            `only: expected exactly one element, found ${list.length}`,
          );
        }
      }),
    );
  });
});

describe("must", () => {
  // Kills a truthiness check, which refuses 0, "", false and NaN.
  test("returns every value that is neither null nor undefined, falsy ones included", () => {
    check(
      property(
        anything().filter((value) => value !== null && value !== undefined),
        (value) => {
          expect(Object.is(must(value), value)).toBe(true);
        },
      ),
    );
  });

  test("throws on undefined and on null, naming which", () => {
    expect(thrown(() => must(undefined))).toBe("must: expected a value, found undefined");
    expect(thrown(() => must(null))).toBe("must: expected a value, found null");
  });
});

describe("rejectionOf", () => {
  test("resolves to the rejection when it is an instance of the class, a subclass's included", async () => {
    const reason = new RefusedHarder("no");
    const found: Refused = await rejectionOf(Promise.reject(reason), Refused);
    expect(found).toBe(reason);
  });

  // Kills a `rejectionOf` that hands back whatever was thrown, which is the
  // cast it exists to replace.
  test("rejects when the rejection is another class, naming both and keeping it as the cause", async () => {
    const reason = new TypeError("not that");
    const failure = await rejectionOf(rejectionOf(Promise.reject(reason), Refused), Error);
    expect(failure.message).toBe(
      "rejectionOf: expected a rejection with Refused, found a rejection with TypeError: not that",
    );
    expect(failure.cause).toBe(reason);
  });

  test("rejects when the rejection is not an Error at all", async () => {
    const failure = await rejectionOf(rejectionOf(Promise.reject("nope"), Refused), Error);
    expect(failure.message).toBe(
      "rejectionOf: expected a rejection with Refused, found a rejection with 'nope'",
    );
  });

  // Kills a `rejectionOf` that resolves to `undefined` when nothing rejected,
  // which an `expect(...).toBeUndefined()` downstream would read as a pass.
  test("rejects when the promise resolves, naming what it resolved to", async () => {
    const failure = await rejectionOf(rejectionOf(Promise.resolve({ id: 7 }), Refused), Error);
    expect(failure.message).toBe(
      "rejectionOf: expected a rejection with Refused, found a resolution with { id: 7 }",
    );
  });
});
