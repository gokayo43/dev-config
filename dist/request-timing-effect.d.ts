import { f as WaitKind, i as Operation } from "./request-timing-operation-BLYTP7sS.js";
import { Effect } from "effect";
//#region request-timing-effect.d.ts
/**
 * Runs `handler` with `operation` as the current one, and answers what it
 * answers, unchanged. Every `measure` in it, and in every fiber it forks,
 * counts in `operation`.
 */
export declare const within: <A, E, R>(operation: Operation, handler: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/**
 * Runs `wait` and adds its duration to the current fiber's operation under
 * `kind`, or answers `wait` itself when the fiber has none. The wait ends when
 * `wait` exits: with a value, a failure, a defect or an interruption.
 */
export declare const measure: <A, E, R>(kind: WaitKind, wait: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
//#endregion