/**
 * What the request-timing connector suites read their oracles through, apart
 * from the servers any of them runs against: what an operation counted, and
 * what a step of a differential settled with.
 */
import { only } from "../narrowing.ts";
import {
  OperationName,
  requestTiming,
  type TimingRecord,
  type WaitKind,
  within,
} from "../request-timing.ts";

/** What one kind of wait came to in a record: its count alone, the part a real server makes deterministic. */
export type Counts = Readonly<Record<WaitKind, number>>;

/** How many waits of each kind a record counted. */
export const countsOf = (record: TimingRecord): Counts => ({
  db: record.db.count,
  out: record.out.count,
  store: record.store.count,
});

/**
 * Runs `work` as one operation and answers what it answered with the counts
 * its record carries, and the time any of its waits was in flight.
 */
export async function counted<T>(
  work: () => Promise<T>,
): Promise<{ answer: T; counts: Counts; inFlightMs: number }> {
  const records: TimingRecord[] = [];
  const operation = requestTiming({
    fault: (error) => {
      throw error;
    },
    sink: (record) => void records.push(record),
  }).open();
  const answer = await within(operation, work);
  operation.close({
    method: "GET",
    name: OperationName.registered("/counted"),
    status: 200,
    aborted: false,
    streamed: false,
  });
  const record = only(records);
  return { answer, counts: countsOf(record), inFlightMs: record.inFlightMs };
}

/** No wait of any kind. */
export const NONE: Counts = { db: 0, out: 0, store: 0 };

/** An error as two runs compare it: its own fields, and its cause's, which drizzle wraps the driver's in. */
interface Described {
  readonly name: string;
  readonly message: string;
  /** Each own field as `name=value`. */
  readonly fields: readonly string[];
  readonly cause: Described | undefined;
}

function described(error: Error): Described {
  return {
    name: error.name,
    message: error.message,
    fields: Object.entries(error).map(([field, value]) => `${field}=${String(value)}`),
    cause: error.cause instanceof Error ? described(error.cause) : undefined,
  };
}

/** What a step settled with, in a form two runs can be compared by. */
export async function outcome(step: () => Promise<unknown>) {
  try {
    return { value: await step() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: described(error) };
  }
}
