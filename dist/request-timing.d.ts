/**
 * Request timing: which operation a wait belongs to, carried in
 * `AsyncLocalStorage`, in plain async code and in an Effect program alike.
 * `docs/exports/request-timing.md` is how an app adopts it, and
 * `request-timing-conformance-effect.ts` says why an Effect program needs
 * nothing more.
 */
import { _ as Waited, a as Ending, c as Operation, d as Sink, f as Timing, g as WaitKind, h as WAIT_KINDS, i as Clock, l as OperationName, m as TimingRecord, n as measure, o as Fault, p as TimingOptions, r as within, s as Method, t as inOperation, u as RECORD_VERSION, v as methodOf, y as requestTiming } from "./request-timing-Cs0lSxaS.js";
export { type Clock, type Ending, type Fault, type Method, type Operation, OperationName, RECORD_VERSION, type Sink, type Timing, type TimingOptions, type TimingRecord, WAIT_KINDS, type WaitKind, type Waited, inOperation, measure, methodOf, requestTiming, within };