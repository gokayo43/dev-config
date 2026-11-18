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
export const RECORD_VERSION = 1;

/** What an operation waited on: its database, an outside HTTP service, or an in-memory store such as Redis. */
export type WaitKind = "db" | "out" | "store";

/** Every kind, in the order the record and the reader list them. */
export const WAIT_KINDS: readonly WaitKind[] = ["db", "out", "store"];

/**
 * The request method a record carries. A method outside the standard set is
 * `OTHER`, since a request line's method is the client's to write and nothing a
 * client writes reaches a record.
 */
export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "OTHER";

/** Every method a record can carry. */
export const METHODS: readonly Method[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "OTHER",
];

/** A request's method as a record carries it: a standard one upper-cased, and every other as `OTHER`. */
export function methodOf(written: string): Method {
  const upper = written.toUpperCase();
  return METHODS.find((method) => method === upper) ?? "OTHER";
}

/** What marks a URL rather than a pattern: a query string, a fragment, a scheme. */
const URL_SHAPED = /[?#]|:\/\//u;

/**
 * An operation's name as its router registered it: `/presets/:id`, never
 * `/presets/42`; a procedure by its registered name. The only ways to make one
 * are `registered`, which a connector hands the router's own pattern, and
 * `unmatched`, so a string read off a request cannot reach a record by
 * accident.
 */
export class OperationName {
  /** The fixed name of a request no route matched. */
  static readonly unmatched = new OperationName("unmatched");

  readonly pattern: string;

  private constructor(pattern: string) {
    this.pattern = pattern;
  }

  /**
   * The name a router registered. Throws on an empty pattern and on one shaped
   * like a URL, with a query string, a fragment or a scheme in it: that is a
   * connector handing over the request's own address, which carries a
   * customer's ids and search terms.
   */
  static registered(pattern: string): OperationName {
    if (pattern === "" || URL_SHAPED.test(pattern)) {
      throw new Error(
        `request timing names an operation by the pattern its router registered, such as /presets/:id; ${JSON.stringify(pattern)} is not one`,
      );
    }
    return new OperationName(pattern);
  }
}

/** One kind's waits in a record: their summed duration and how many there were. */
export interface Waited {
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
export interface TimingRecord {
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
export type Sink = (record: TimingRecord) => void;

/** Milliseconds since the epoch, fractional. Two readings subtract to a duration. */
export type Clock = () => number;

/** How an operation ended, which `close` takes. */
export interface Ending {
  readonly method: Method;
  readonly name: OperationName;
  /** The status the client received, a handler that threw included. */
  readonly status: number;
  readonly aborted: boolean;
  readonly streamed: boolean;
}

/** Ends one wait; called once, when the wait settles. */
type EndWait = () => void;

const ignored: EndWait = () => undefined;

/** Records carry microseconds: more digits are noise from the clock, and bytes in every log line. */
const micro = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * Starts a wait of `kind` against `operation`, answering what ends it. A
 * carrier's half of `measure`, exported for the Effect carrier's sake.
 */
export let beginWait: (operation: Operation, kind: WaitKind) => EndWait;

let openOperation: (now: Clock, sink: Sink) => Operation;

/** What switching request timing on answers: the one way to open an operation. */
export interface Timing {
  /**
   * Opens an operation now. The connector that opens it runs the handler under
   * it with a carrier's `within` and closes it once its response has finished.
   */
  readonly open: () => Operation;
}

/** What `requestTiming` takes. */
export interface TimingOptions {
  /** Where each record goes: the app writes it as one JSON line on stdout. */
  readonly sink: Sink;
  /**
   * The clock every duration is read from. Unset is the process's monotonic
   * clock on the epoch, `performance.timeOrigin + performance.now()`; a test
   * passes a virtual one.
   */
  readonly now?: Clock;
}

const monotonic: Clock = () => performance.timeOrigin + performance.now();

/**
 * Switches request timing on: every operation opened through the answer closes
 * into one record handed to `sink`. Nothing is written by the export itself.
 */
export function requestTiming(options: TimingOptions): Timing {
  const now = options.now ?? monotonic;
  return { open: () => openOperation(now, options.sink) };
}

/**
 * One operation from open to close: what it waited on, and the record it
 * closes into. Opened by `Timing.open`, carried by either carrier's `within`,
 * and closed by the connector that opened it, once, when the response has
 * finished.
 */
export class Operation {
  readonly #now: Clock;
  readonly #sink: Sink;
  readonly #openedAt: number;
  readonly #sums: Record<WaitKind, number> = { db: 0, out: 0, store: 0 };
  readonly #counts: Record<WaitKind, number> = { db: 0, out: 0, store: 0 };
  #sealed = false;
  /** Waits begun and not yet ended. */
  #active = 0;
  /** When `#active` last rose from zero. */
  #busySince = 0;
  #inFlight = 0;

  static {
    beginWait = (operation, kind) => operation.#begin(kind);
    openOperation = (now, sink) => new Operation(now, sink);
  }

  private constructor(now: Clock, sink: Sink) {
    this.#now = now;
    this.#sink = sink;
    this.#openedAt = now();
  }

  #begin(kind: WaitKind): EndWait {
    if (this.#sealed) return ignored;
    const began = this.#now();
    if (this.#active === 0) this.#busySince = began;
    this.#active += 1;
    return () => {
      if (this.#sealed) return;
      const ended = this.#now();
      this.#sums[kind] += ended - began;
      this.#counts[kind] += 1;
      this.#active -= 1;
      if (this.#active === 0) this.#inFlight += ended - this.#busySince;
    };
  }

  /**
   * Seals the operation and hands its record to the sink. A wait still in
   * flight counts in no kind's sum or count, now or when it settles, though the
   * time it was in flight before the close is in `inFlightMs`. Throws on a
   * second close, since a connector closing twice is emitting a second record
   * for one response, and on a status outside 100 to 599. A sink that throws
   * throws out of here, after the operation is sealed.
   */
  close(ending: Ending): void {
    if (this.#sealed) {
      throw new Error(
        `request timing: ${ending.method} ${ending.name.pattern} was closed twice; a connector closes an operation once, when its response has finished`,
      );
    }
    if (!Number.isInteger(ending.status) || ending.status < 100 || ending.status > 599) {
      throw new Error(
        `request timing: ${ending.method} ${ending.name.pattern} closed with status ${ending.status}, which is not an HTTP status`,
      );
    }
    const closedAt = this.#now();
    this.#sealed = true;
    const inFlight = this.#inFlight + (this.#active > 0 ? closedAt - this.#busySince : 0);
    const waited = (kind: WaitKind): Waited => ({
      waitMs: micro(this.#sums[kind]),
      count: this.#counts[kind],
    });
    this.#sink({
      requestTiming: RECORD_VERSION,
      at: new Date(closedAt).toISOString(),
      method: ending.method,
      operation: ending.name.pattern,
      status: ending.status,
      totalMs: micro(closedAt - this.#openedAt),
      inFlightMs: micro(inFlight),
      db: waited("db"),
      out: waited("out"),
      store: waited("store"),
      aborted: ending.aborted,
      streamed: ending.streamed,
    });
  }
}
