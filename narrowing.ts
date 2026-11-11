/**
 * Four calls that hand back a value the compiler could not prove present, or
 * throw saying what was expected and what was found. They are what a case
 * writes instead of `rows[0]!`, `rows[0]?.sku` inside `expect`, or `as
 * TypeError` on a caught error: a `!` passes `undefined` on silently wherever
 * no dereference follows it, a `?.` turns an absence assertion such as
 * `.toBeUndefined()` green when the list is empty, and a cast claims a class
 * nothing checked.
 *
 * Nothing here imports a test runner, so a `bun test` case and a Playwright
 * spec under node take the same module.
 */

import { inspect } from "node:util";

/** A value as a failure message shows it: an error by its name and message, since its stack rides along as the `cause`. */
function shown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return inspect(value, { depth: 2, breakLength: Number.POSITIVE_INFINITY });
}

/** The element at `index`, which must be one the list holds. */
export function nth<T>(list: readonly T[], index: number): T {
  for (const [at, element] of list.entries()) if (at === index) return element;
  throw new Error(
    `nth: expected an element at index ${index}, found a list of length ${list.length}`,
  );
}

/** The one element of a list that must hold exactly one. */
export function only<T>(list: readonly T[]): T {
  if (list.length !== 1) {
    throw new Error(`only: expected exactly one element, found ${list.length}`);
  }
  return nth(list, 0);
}

/** A value that must be neither `null` nor `undefined`. */
export function must<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`must: expected a value, found ${String(value)}`);
  }
  return value;
}

/**
 * What `promise` rejects with, which must be an instance of `Class`, typed as
 * that class. A resolution, or a rejection with anything else, rejects, and the
 * rejection a caller did not expect rides along as the `cause`.
 */
export async function rejectionOf<Value, Failure>(
  promise: PromiseLike<Value>,
  Class: abstract new (...args: never[]) => Failure,
): Promise<Failure> {
  let value: Value;
  try {
    value = await promise;
  } catch (error) {
    if (error instanceof Class) return error;
    throw new Error(
      `rejectionOf: expected a rejection with ${Class.name}, found a rejection with ${shown(error)}`,
      { cause: error },
    );
  }
  throw new Error(
    `rejectionOf: expected a rejection with ${Class.name}, found a resolution with ${shown(value)}`,
  );
}
