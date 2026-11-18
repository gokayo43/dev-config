import { a as Operation, c as Sink, d as TimingRecord, f as WAIT_KINDS, g as requestTiming, h as methodOf, i as Method, l as Timing, m as Waited, n as Ending, o as OperationName, p as WaitKind, r as Fault, s as RECORD_VERSION, t as Clock, u as TimingOptions } from "./request-timing-operation-BG4yllkT.js";
//#region request-timing.d.ts
/**
 * Whether an operation is current. An entry connector asks it before opening
 * one and opens nothing when it answers true, so work a page runs in-process
 * during its own request, such as a server function it calls, counts in the
 * page's operation and operations never nest.
 */
export declare function inOperation(): boolean;
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
export { type Clock, type Ending, type Fault, type Method, type Operation, OperationName, RECORD_VERSION, type Sink, type Timing, type TimingOptions, type TimingRecord, WAIT_KINDS, type WaitKind, type Waited, methodOf, requestTiming };