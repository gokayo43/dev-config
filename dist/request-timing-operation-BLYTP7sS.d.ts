//#region request-timing-operation.d.ts
/**
 * What both carriers of request timing share: the operation, the waits it
 * accumulates, and the record it closes into. No export names this file. The
 * plain carrier re-exports its public half, and the Effect carrier reaches the
 * one function a carrier needs, `beginWait`, which no app or connector calls.
 *
 * It imports nothing at all, so the plain export stays free of `effect` and the
 * Effect export stays free of `node:async_hooks`.
 */
/**
 * The schema version every record carries under `requestTiming`. The reader
 * knows this version alone, and stops on a record of any other.
 */
declare const RECORD_VERSION = 1;
/** What an operation waited on: its database, an outside HTTP service, or an in-memory store such as Redis. */
type WaitKind = "db" | "out" | "store";
/** Every kind, in the order the record and the reader list them. */
declare const WAIT_KINDS: readonly WaitKind[];
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
   * address, which carries a customer's ids and search terms, so the error says
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
interface TimingRecord {
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
  readonly db: Waited;
  readonly out: Waited;
  readonly store: Waited;
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
/** What switching request timing on answers: the one way to open an operation. */
interface Timing {
  /**
   * Opens an operation now. The connector that opens it runs the handler under
   * it with a carrier's `within` and closes it once its response has finished.
   */
  readonly open: () => Operation;
}
/** What `requestTiming` takes. */
interface TimingOptions {
  /** Where each record goes: the app writes it as one JSON line on stdout. */
  readonly sink: Sink;
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
 * closes into. Opened by `Timing.open`, carried by either carrier's `within`,
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
//#endregion
export { OperationName as a, Timing as c, WAIT_KINDS as d, WaitKind as f, requestTiming as h, Operation as i, TimingOptions as l, methodOf as m, Ending as n, RECORD_VERSION as o, Waited as p, Method as r, Sink as s, Clock as t, TimingRecord as u };