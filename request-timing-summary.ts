/**
 * What the request-timing reader makes of a log: the records among its lines,
 * and per operation where the time went. `request-timing-report.ts` is the bin
 * that feeds it stdin, and the conformance kit reads a record with `parseRecord`.
 */
import {
  METHODS,
  patternProblem,
  perKind,
  RECORD_VERSION,
  type Method,
  type TimingRecord,
  WAIT_KINDS,
  type WaitKind,
  type Waited,
} from "./request-timing-operation.ts";

/** The reader's exit status when it printed a summary. */
export const SUMMARISED = 0;
/** The reader's exit status on a record it cannot read, a schema version it does not know, or an argument it does not take. */
export const UNREADABLE = 1;
/** The reader's exit status when the input held no record at all, so an empty window is never read as a fast one. */
export const NO_RECORD = 2;

/** A line that claims to be a record and is not one this reader can read. */
export class UnreadableRecord extends Error {}

/** The share of an operation's summed time each kind of wait took, and the rest; a kind's share exceeds 1 where its waits ran in parallel. */
export type Shares = Readonly<Record<WaitKind | "rest", number>>;

/** One operation's records, summed. */
export interface OperationSummary {
  readonly method: Method;
  readonly operation: string;
  readonly streamed: boolean;
  readonly count: number;
  readonly aborted: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly shares: Shares;
  /** Waits per record, by kind. */
  readonly waitsPerOperation: Readonly<Record<WaitKind, number>>;
}

/** Everything the reader prints. */
export interface Summary {
  readonly lines: number;
  readonly records: number;
  readonly days: readonly { readonly day: string; readonly records: number }[];
  /** Operations whose responses were not streamed, slowest mean first. */
  readonly operations: readonly OperationSummary[];
  /** Streamed operations, ranked apart by the same measure, so a minutes-long stream does not top the list above. */
  readonly streamed: readonly OperationSummary[];
}

/** The form `Date.prototype.toISOString` writes `at` in, and the only one read, since the day the reader prints is its first ten characters. */
const EMITTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** A parsed JSON object's fields, as nothing yet says what they are; nothing for any other value. */
function fieldsOf(value: unknown): ReadonlyMap<string, unknown> {
  return new Map(typeof value === "object" && value !== null ? Object.entries(value) : []);
}

const numberIn = (fields: ReadonlyMap<string, unknown>, key: string) => {
  const found = fields.get(key);
  return typeof found === "number" && Number.isFinite(found) && found >= 0 ? found : undefined;
};

const refused = (why: string) =>
  new UnreadableRecord(
    `a version ${RECORD_VERSION} record whose operation is not a name a router registered: ${why}`,
  );

/**
 * The record a log line holds, or nothing for a line that is not one: not JSON,
 * not an object, or an object without `requestTiming`. Throws `UnreadableRecord`
 * on a record of a schema version other than `RECORD_VERSION`, naming that
 * version where it is a whole number, and on a record of this version missing a
 * field or holding one of the wrong type. No message quotes a value off the
 * line: what an agent reads on stderr is the reader's words and the field's
 * name, never text a log line put there.
 */
export function parseRecord(line: string): TimingRecord | undefined {
  // Most lines of a log are not records, and this is the cheap way past them.
  if (!line.includes('"requestTiming"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const fields = fieldsOf(parsed);
  if (Array.isArray(parsed) || !fields.has("requestTiming")) return undefined;
  const version = fields.get("requestTiming");
  if (version !== RECORD_VERSION) {
    throw new UnreadableRecord(
      `a record of ${Number.isSafeInteger(version) ? `schema version ${String(version)}` : "a schema version that is not a whole number"}; this reader knows version ${RECORD_VERSION} alone, so read this log with the @gokayo43/dev-config that wrote it`,
    );
  }
  const wrong = (field: string): never => {
    throw new UnreadableRecord(
      `a version ${RECORD_VERSION} record whose ${field} is ${fields.has(field) ? "not what that version holds there" : "absent"}`,
    );
  };
  const number = (field: string): number => numberIn(fields, field) ?? wrong(field);
  const flag = (field: string): boolean => {
    const found = fields.get(field);
    return typeof found === "boolean" ? found : wrong(field);
  };
  const text = (field: string): string => {
    const found = fields.get(field);
    return typeof found === "string" ? found : wrong(field);
  };
  const waited = (kind: WaitKind): Waited => {
    const nested = fieldsOf(fields.get(kind));
    const waitMs = numberIn(nested, "waitMs");
    const count = numberIn(nested, "count");
    return waitMs !== undefined && count !== undefined && Number.isInteger(count)
      ? { waitMs, count }
      : wrong(kind);
  };
  // Not `text`: an operation is refused with `patternProblem`'s reason, the
  // one rule the core names operations by.
  const operation = fields.get("operation");
  if (typeof operation !== "string") throw refused("it is not a string");
  const problem = patternProblem(operation);
  if (problem !== undefined) throw refused(problem);
  const at = text("at");
  if (!EMITTED_AT.test(at) || Number.isNaN(Date.parse(at))) wrong("at");
  const method = METHODS.find((known) => known === fields.get("method")) ?? wrong("method");
  const status = number("status");
  if (!Number.isInteger(status) || status < 100 || status > 599) wrong("status");
  const totalMs = number("totalMs");
  const inFlightMs = number("inFlightMs");
  if (inFlightMs > totalMs) wrong("inFlightMs");
  return {
    requestTiming: RECORD_VERSION,
    at,
    method,
    operation,
    status,
    totalMs,
    inFlightMs,
    ...perKind(waited),
    aborted: flag("aborted"),
    streamed: flag("streamed"),
  };
}

interface Sums {
  readonly method: Method;
  readonly operation: string;
  readonly streamed: boolean;
  count: number;
  aborted: number;
  totalMs: number;
  restMs: number;
  waitMs: Record<WaitKind, number>;
  waits: Record<WaitKind, number>;
}

/** Folds a log into a `Summary` one line at a time, holding one entry per operation and per day. */
export class Reader {
  #position = 0;
  #lines = 0;
  #records = 0;
  readonly #days = new Map<string, number>();
  readonly #operations = new Map<string, Sums>();

  /**
   * Takes the next line. A blank one is numbered and not counted, which keeps
   * the empty string after a log's final newline out of `lines`. Throws
   * `UnreadableRecord`, prefixed with the line's number, as `parseRecord` does.
   */
  add(line: string): void {
    this.#position += 1;
    if (line.trim() === "") return;
    this.#lines += 1;
    let record: TimingRecord | undefined;
    try {
      record = parseRecord(line);
    } catch (error) {
      if (!(error instanceof UnreadableRecord)) throw error;
      throw new UnreadableRecord(`line ${this.#position} is ${error.message}`, { cause: error });
    }
    if (record === undefined) return;
    this.#records += 1;
    const day = record.at.slice(0, 10);
    this.#days.set(day, (this.#days.get(day) ?? 0) + 1);
    const key = JSON.stringify([record.method, record.operation, record.streamed]);
    const sums = this.#operations.get(key) ?? {
      method: record.method,
      operation: record.operation,
      streamed: record.streamed,
      count: 0,
      aborted: 0,
      totalMs: 0,
      restMs: 0,
      waitMs: perKind(() => 0),
      waits: perKind(() => 0),
    };
    sums.count += 1;
    sums.aborted += record.aborted ? 1 : 0;
    sums.totalMs += record.totalMs;
    sums.restMs += record.totalMs - record.inFlightMs;
    for (const kind of WAIT_KINDS) {
      sums.waitMs[kind] += record[kind].waitMs;
      sums.waits[kind] += record[kind].count;
    }
    this.#operations.set(key, sums);
  }

  /** What the lines taken so far add up to. */
  summary(): Summary {
    const ranked = [...this.#operations.values()]
      .map(summarise)
      .toSorted((a, b) => b.meanMs - a.meanMs);
    return {
      lines: this.#lines,
      records: this.#records,
      days: [...this.#days]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([day, records]) => ({ day, records })),
      operations: ranked.filter((row) => !row.streamed),
      streamed: ranked.filter((row) => row.streamed),
    };
  }
}

function summarise(sums: Sums): OperationSummary {
  // A share of nothing is nothing: every record of the operation took 0ms at
  // the record's microsecond precision.
  const share = (ms: number) => (sums.totalMs === 0 ? 0 : ms / sums.totalMs);
  return {
    method: sums.method,
    operation: sums.operation,
    streamed: sums.streamed,
    count: sums.count,
    aborted: sums.aborted,
    totalMs: sums.totalMs,
    meanMs: sums.totalMs / sums.count,
    shares: { ...perKind((kind) => share(sums.waitMs[kind])), rest: share(sums.restMs) },
    waitsPerOperation: perKind((kind) => sums.waits[kind] / sums.count),
  };
}

const HEADER = [
  "rank",
  "method",
  "operation",
  "count",
  "aborted",
  "mean ms",
  "total ms",
  ...WAIT_KINDS,
  "rest",
  ...WAIT_KINDS.map((kind) => `${kind}/op`),
];

const percent = (share: number) => `${Math.round(share * 100)}%`;

function table(rows: readonly OperationSummary[]): string {
  const cells = [
    HEADER,
    ...rows.map((row, index) => [
      String(index + 1),
      row.method,
      row.operation,
      String(row.count),
      String(row.aborted),
      row.meanMs.toFixed(1),
      row.totalMs.toFixed(0),
      ...WAIT_KINDS.map((kind) => percent(row.shares[kind])),
      percent(row.shares.rest),
      ...WAIT_KINDS.map((kind) => row.waitsPerOperation[kind].toFixed(1)),
    ]),
  ];
  const widths = HEADER.map((_, column) =>
    Math.max(...cells.map((line) => line[column]?.length ?? 0)),
  );
  return cells
    .map((line) =>
      line
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * The summary as a person reads it. The shares are of the operation's summed
 * time: a kind's share passes 100% where its waits ran in parallel, and the
 * rest is the time no wait was in flight, which holds the code's own time and
 * every wait nobody measured.
 */
export function printed(summary: Summary): string {
  const sections = [
    `${summary.records} records in ${summary.lines} lines`,
    ["records per day", ...summary.days.map(({ day, records }) => `  ${day}  ${records}`)].join(
      "\n",
    ),
    `operations, slowest mean first\n${table(summary.operations)}`,
  ];
  if (summary.streamed.length > 0) {
    sections.push(`streamed operations, slowest mean first\n${table(summary.streamed)}`);
  }
  return `${sections.join("\n\n")}\n`;
}
