/**
 * What request timing's modules share: the operation, the waits it
 * accumulates, the record it closes into, and the storage that carries the
 * current operation. No export names this file. `request-timing.ts`
 * re-exports its public half, and `beginWait` is for the connectors that
 * measure a driver's query object without the thunk form of `measure`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The schema version every record carries under `requestTiming`. The reader
 * knows this version alone, and stops on a record of any other.
 */
export const RECORD_VERSION = 1;

/**
 * Every kind of wait, in the order the record and the reader list them: the
 * database, an outside HTTP service, an in-memory store such as Redis. A new
 * kind is an entry here and one in `perKind`, which the compiler then asks for.
 */
export const WAIT_KINDS = ["db", "out", "store"] as const;

/** What an operation waited on. */
export type WaitKind = (typeof WAIT_KINDS)[number];

/** One value for each kind of wait. */
export type PerKind<T> = { [Kind in WaitKind]: T };

/** One value per kind of wait, each `of` that kind. */
export function perKind<T>(of: (kind: WaitKind) => T) {
  return { db: of("db"), out: of("out"), store: of("store") } satisfies PerKind<T>;
}

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

/**
 * The longest name a record carries, in UTF-16 code units. A registered route
 * or procedure name is a few dozen; the bound keeps one crafted log line from
 * filling a reader's screen.
 */
export const MAX_PATTERN_LENGTH = 256;

/** What marks a URL rather than a pattern: a query string, a fragment, a scheme. */
const URL_SHAPED = /[?#]|:\/\//u;

/** Every character that does not print as itself: control, format, unassigned and private-use characters, and every space or line separator. */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/**
 * Why `pattern` is not a name a router could have registered, or nothing where
 * it is one. `OperationName.registered` and the reader both ask it, so every
 * record a connector can write is one the reader reads, and a log line the
 * reader prints cannot carry a terminal escape or a fake row. The answer never
 * quotes the pattern, which on a refusal is likely a request's own address.
 */
export function patternProblem(pattern: string): string | undefined {
  if (pattern === "") return "it is empty";
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `it is longer than ${MAX_PATTERN_LENGTH} characters`;
  }
  if (UNPRINTABLE.test(pattern)) {
    return "it holds a space, a control character or another character that does not print";
  }
  if (URL_SHAPED.test(pattern)) {
    return "it holds a query string, a fragment or a scheme, which makes it a request's own address";
  }
  return undefined;
}

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
   * The name a router registered. Throws where `patternProblem` names one: a
   * pattern shaped like a URL is a connector handing over the request's own
   * address, which carries a person's ids and search terms, so the error says
   * what shape was refused and quotes none of it.
   */
  static registered(pattern: string): OperationName {
    const problem = patternProblem(pattern);
    if (problem !== undefined) {
      throw new Error(
        `request timing names an operation by the pattern its router registered, such as /presets/:id; this one was refused because ${problem}`,
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
export interface TimingRecord extends Readonly<PerKind<Waited>> {
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
 * Starts a wait of `kind` against `operation`, answering what ends it: the
 * half of `measure` a connector calls where a driver's query object cannot be
 * wrapped in a thunk.
 */
export let beginWait: (operation: Operation, kind: WaitKind) => EndWait;

let openOperation: (now: Clock, sink: Sink) => Operation;

/**
 * Where a fault in closing an operation goes: a sink that threw, a name or a
 * status the core refused, a second close. The app supplies it, so a fault is
 * logged the app's way and never turns a served response into a failed one.
 */
export type Fault = (error: unknown) => void;

/** What switching request timing on answers: the one way to open an operation, and the way a connector closes one. */
export interface Timing {
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
export interface TimingOptions {
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

const monotonic: Clock = () => performance.timeOrigin + performance.now();

/**
 * Switches request timing on: every operation opened through the answer closes
 * into one record handed to `sink`. Nothing is written by the export itself.
 */
export function requestTiming(options: TimingOptions): Timing {
  const now = options.now ?? monotonic;
  return {
    open: () => openOperation(now, options.sink),
    finish: (operation, ended) => {
      try {
        operation.close(ended());
      } catch (error) {
        options.fault(error);
      }
    },
  };
}

/** Which operation is current, read by `measure` and `inOperation` and set by `within`. */
export const current = new AsyncLocalStorage<Operation>();

/**
 * One operation from open to close: what it waited on, and the record it
 * closes into. Opened by `Timing.open`, made current by `within`,
 * and closed by the connector that opened it, once, when the response has
 * finished.
 */
export class Operation {
  readonly #now: Clock;
  readonly #sink: Sink;
  readonly #openedAt: number;
  readonly #sums = perKind(() => 0);
  readonly #counts = perKind(() => 0);
  #sealed = false;
  /** Waits begun and not yet ended. */
  #active = 0;
  /** When `#active` last rose from zero. */
  #busySince = 0;
  #inFlight = 0;

  // The one place a module function can reach a `#private` member. A public
  // `begin` would be on the exported `Operation` type, and a WeakMap from
  // operation to state would need a lookup no operation can miss.
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
      ...perKind(waited),
      aborted: ending.aborted,
      streamed: ending.streamed,
    });
  }
}
