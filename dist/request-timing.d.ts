import { a as OperationName, c as Timing, d as WAIT_KINDS, f as WaitKind, h as requestTiming, i as Operation, l as TimingOptions, m as methodOf, n as Ending, o as RECORD_VERSION, p as Waited, r as Method, s as Sink, t as Clock, u as TimingRecord } from "./request-timing-operation-BLYTP7sS.js";
//#region request-timing.d.ts
/**
 * Runs `handler` with `operation` as the current one, and answers what it
 * answers, unchanged. Every `measure` called from it, or from anything it
 * starts that keeps its async context, counts in `operation`.
 */
export declare function within<T>(operation: Operation, handler: () => T): T;
/**
 * Runs `wait` and adds its duration to the current operation under `kind`, or
 * to nothing when no operation is current. The operation is read when
 * `measure` is called, so a wait belongs to the operation that issued it
 * whoever settles it. The answer settles as `wait`'s promise does, with its
 * value or its rejection, and a synchronous throw is thrown on. `wait` is
 * called once, and a thenable it answers has its `then` called once.
 */
export declare function measure<T>(kind: WaitKind, wait: () => PromiseLike<T>): Promise<T>;
//#endregion
export { type Clock, type Ending, type Method, type Operation, OperationName, RECORD_VERSION, type Sink, type Timing, type TimingOptions, type TimingRecord, WAIT_KINDS, type WaitKind, type Waited, methodOf, requestTiming };