/**
 * The request-timing conformance kit: an adopting app's own suite runs it
 * against its own booted server, to show that one operation which makes a known
 * number of database waits closes into exactly one record carrying that number.
 *
 * ```ts
 * test("request timing", () =>
 *   requestTimingConforms({
 *     method: "GET",
 *     operation: "/presets/:id",
 *     dbWaits: 2,
 *     drive: async () => void (await (await fetch(`${server.url}presets/1`)).text()),
 *     next: () => lines.next(),
 *   }));
 * ```
 *
 * It drives the operation twice, one request after the other, and reads the
 * lines the server's sink writes in between, skipping every line that is not a
 * record. Each request must be answered by one record, of the method and
 * operation named, with `dbWaits` database waits: a second record for one
 * request is read in place of the next request's, and a connector that misses
 * a wait or opens a second operation around the handler leaves a record with
 * the wrong count. A server that writes no record leaves `next` waiting, and
 * the test fails at its timeout.
 */
import { expect } from "bun:test";

import type { Method } from "./request-timing-operation.ts";
import { parseRecord } from "./request-timing-summary.ts";

/** One operation of the app's booted server, and the way to read what its sink writes. */
export interface ConformanceTarget {
  readonly method: Method;
  /** The name the router registered for the operation, as the record carries it. */
  readonly operation: string;
  /** How many database waits one request for the operation makes, at least 1. */
  readonly dbWaits: number;
  /** Sends one request for the operation, resolving once its response has been read to the end. */
  readonly drive: () => Promise<void>;
  /** Resolves with the next line the server's sink writes, in the order written. */
  readonly next: () => Promise<string>;
}

async function nextRecord(target: ConformanceTarget) {
  for (;;) {
    const record = parseRecord(await target.next());
    if (record !== undefined) return record;
  }
}

/** Rejects, through bun:test's `expect`, unless each of two requests for the operation is answered by its one record. */
export async function requestTimingConforms(target: ConformanceTarget): Promise<void> {
  if (!Number.isInteger(target.dbWaits) || target.dbWaits < 1) {
    throw new Error(
      `requestTimingConforms takes an operation that makes at least one database wait, and was given dbWaits ${target.dbWaits}: with none, a second operation opened around the handler writes a record no different from the first`,
    );
  }
  for (const request of ["first", "second"]) {
    await target.drive();
    const record = await nextRecord(target);
    expect(
      { method: record.method, operation: record.operation, dbWaits: record.db.count },
      `the record the ${request} request was answered by`,
    ).toEqual({ method: target.method, operation: target.operation, dbWaits: target.dbWaits });
  }
}
