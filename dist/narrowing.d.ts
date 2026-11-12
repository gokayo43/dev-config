//#region narrowing.d.ts
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
/** The element at `index`, which must be one the list holds. */
export declare function nth<T>(list: readonly T[], index: number): T;
/** The one element of a list that must hold exactly one. */
export declare function only<T>(list: readonly T[]): T;
/** A value that must be neither `null` nor `undefined`. */
export declare function must<T>(value: T): NonNullable<T>;
/**
 * What `promise` rejects with, which must be an instance of `Class`, typed as
 * that class. A resolution, or a rejection with anything else, rejects, and the
 * rejection a caller did not expect rides along as the `cause`.
 */
export declare function rejectionOf<Value, Failure>(promise: PromiseLike<Value>, Class: abstract new (...args: never[]) => Failure): Promise<Failure>;
//#endregion