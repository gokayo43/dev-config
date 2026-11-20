import "node:async_hooks";
/**
 * The schema version every record carries under `requestTiming`. The reader
 * knows this version alone, and stops on a record of any other.
 */
declare const RECORD_VERSION = 1;
/**
 * Every kind of wait, in the order the record and the reader list them: the
 * database, an outside HTTP service, an in-memory store such as Redis. A new
 * kind is an entry here and one in `perKind`, which the compiler then asks for.
 */
declare const WAIT_KINDS: readonly ["db", "out", "store"];
/** What an operation waited on. */
type WaitKind = (typeof WAIT_KINDS)[number];
/** One value for each kind of wait. */
type PerKind<T> = { [Kind in WaitKind]: T; };
/**
 * The request method a record carries. A method outside the standard set is
 * `OTHER`, since a request line's method is the client's to write and nothing a
 * client writes reaches a record.
 */
type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "OTHER";
/** A request's method as a record carries it: a standard one upper-cased, and every other as `OTHER`. */
declare function methodOf(written: string): Method;
/**
 * An operation's name as its router registered it: `/presets/:id`, never
 * `/presets/42`; a procedure by its registered name. The only ways to make one
 * are `registered`, which a connector hands the router's own pattern, and
 * `unmatched`, so a string read off a request cannot reach a record by
 * accident.
 */
declare class OperationName {
  /** The fixed name of a request no route matched. */
  static readonly unmatched: OperationName;
  readonly pattern: string;
  private constructor();
  /**
   * The name a router registered. Throws where `patternProblem` names one: a
   * pattern shaped like a URL is a connector handing over the request's own
   * address, which carries a person's ids and search terms, so the error says
   * what shape was refused and quotes none of it.
   */
  static registered(pattern: string): OperationName;
}
/** One kind's waits in a record: their summed duration and how many there were. */
interface Waited {
  readonly waitMs: number;
  readonly count: number;
}
/**
 * The record one operation closes into, written by the app's sink as one JSON
 * object on one line. Every field is a number, a boolean, a closed set of
 * words, the time of emission, or the name a router registered, so no query
 * text, parameter, query string, header, body or outside host can be
 * represented in it.
 */
interface TimingRecord extends Readonly<PerKind<Waited>> {
  /** The schema version, `RECORD_VERSION`; its presence is what makes a line a record. */
  readonly requestTiming: typeof RECORD_VERSION;
  /** When the record was emitted, as an ISO 8601 UTC timestamp. */
  readonly at: string;
  readonly method: Method;
  /** `OperationName.pattern`. */
  readonly operation: string;
  /** The status the client received. */
  readonly status: number;
  /** From open to close. */
  readonly totalMs: number;
  /** The time during which at least one of the operation's waits was in flight; the rest is `totalMs - inFlightMs`. */
  readonly inFlightMs: number;
  /** The client went away before the response finished. */
  readonly aborted: boolean;
  /** The response body was streamed. */
  readonly streamed: boolean;
}
/** Where records go. The app supplies it, and it is called once per operation, inside `close`. */
type Sink = (record: TimingRecord) => void;
/** Milliseconds since the epoch, fractional. Two readings subtract to a duration. */
type Clock = () => number;
/** How an operation ended, which `close` takes. */
interface Ending {
  readonly method: Method;
  readonly name: OperationName;
  /** The status the client received, a handler that threw included. */
  readonly status: number;
  readonly aborted: boolean;
  readonly streamed: boolean;
}
/**
 * Where a fault in closing an operation goes: a sink that threw, a name or a
 * status the core refused, a second close. The app supplies it, so a fault is
 * logged the app's way and never turns a served response into a failed one.
 */
type Fault = (error: unknown) => void;
/** What switching request timing on answers: the one way to open an operation, and the way a connector closes one. */
interface Timing {
  /**
   * Opens an operation now. The connector that opens it runs the handler under
   * it with `within` and closes it with `finish` once its response
   * has finished.
   */
  readonly open: () => Operation;
  /**
   * Closes `operation` with the ending `ended` builds, handing anything that
   * throws to the app's `fault` instead of the caller: `ended` itself, where
   * the name it registers is refused, and `close`, where the status is
   * refused, the sink throws or the operation was closed already. So a
   * connector closing after the response, in a callback or a `then`, never
   * leaves an unhandled rejection or a failed response. A `fault` that throws
   * is the app's own error and is not caught.
   */
  readonly finish: (operation: Operation, ended: () => Ending) => void;
}
/** What `requestTiming` takes. */
interface TimingOptions {
  /** Where each record goes: the app writes it as one JSON line on stdout. */
  readonly sink: Sink;
  /** Where a fault in closing an operation goes, through `Timing.finish`: the app logs it. */
  readonly fault: Fault;
  /**
   * The clock every duration is read from. Unset is the process's monotonic
   * clock on the epoch, `performance.timeOrigin + performance.now()`; a test
   * passes a virtual one.
   */
  readonly now?: Clock;
}
/**
 * Switches request timing on: every operation opened through the answer closes
 * into one record handed to `sink`. Nothing is written by the export itself.
 */
declare function requestTiming(options: TimingOptions): Timing;
/**
 * One operation from open to close: what it waited on, and the record it
 * closes into. Opened by `Timing.open`, made current by `within`,
 * and closed by the connector that opened it, once, when the response has
 * finished.
 */
declare class Operation {
  #private;
  private constructor();
  /**
   * Seals the operation and hands its record to the sink. A wait still in
   * flight counts in no kind's sum or count, now or when it settles, though the
   * time it was in flight before the close is in `inFlightMs`. Throws on a
   * second close, since a connector closing twice is emitting a second record
   * for one response, and on a status outside 100 to 599. A sink that throws
   * throws out of here, after the operation is sealed.
   */
  close(ending: Ending): void;
}
/**
 * Whether an operation is current. An entry connector asks it before opening
 * one and opens nothing when it answers true, so work a page runs in-process
 * during its own request, such as a server function it calls, counts in the
 * page's operation and operations never nest.
 */
declare function inOperation(): boolean;
/**
 * Runs `handler` with `operation` as the current one, and answers what it
 * answers, unchanged. Every `measure` called from it, or from anything it
 * starts that keeps its async context, counts in `operation`.
 */
declare function within<T>(operation: Operation, handler: () => T): T;
/**
 * Runs `wait` and adds its duration to the current operation under `kind`, or
 * to nothing when no operation is current. The operation is read when
 * `measure` is called, so a wait belongs to the operation that issued it
 * whoever settles it. The answer settles as `wait`'s promise does, with its
 * value or its rejection, and a synchronous throw is thrown on. `wait` is
 * called once, and a thenable it answers has its `then` called once.
 */
declare function measure<T>(kind: WaitKind, wait: () => PromiseLike<T>): Promise<T>;
export { Waited as _, Ending as a, Operation as c, Sink as d, Timing as f, WaitKind as g, WAIT_KINDS as h, Clock as i, OperationName as l, TimingRecord as m, measure as n, Fault as o, TimingOptions as p, within as r, Method as s, inOperation as t, RECORD_VERSION as u, methodOf as v, requestTiming as y };