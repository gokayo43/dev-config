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
import { join } from "node:path";

import type { Method } from "./request-timing-operation.ts";
import { markOf } from "./request-timing-route.ts";
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

/** The handlers a `route.ts` can export, one per method Next.js routes to it. */
const ROUTE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * The pattern Next.js routes the route file at `file`, relative to the `app`
 * directory, at: route groups `(name)` and parallel slots `@name` left out,
 * a leading `%5F` read as the underscore it stands for, and dynamic segments
 * as written. Nothing for a file under a private folder `_name`, which Next.js
 * routes nothing from.
 */
export function routePattern(file: string): string | undefined {
  const segments = file.split("/").slice(0, -1);
  if (segments.some((segment) => segment.startsWith("_"))) return undefined;
  const routed = segments
    .filter((segment) => !/^\(.*\)$/u.test(segment) && !segment.startsWith("@"))
    .map((segment) => segment.replaceAll(/%5F/giu, "_"));
  return `/${routed.join("/")}`;
}

/** What is wrong with one handler a route file exports, or nothing. */
function handlerProblem(exported: unknown, pattern: string): string | undefined {
  if (typeof exported !== "function") return "is not a function";
  const mark = markOf(exported);
  if (mark === undefined) {
    return `is not wrapped by request timing: wrap it with the app's route wrapper and the pattern "${pattern}", or, where the route carries procedures, with their envelope`;
  }
  if (mark.kind === "route" && mark.pattern !== pattern) {
    return `is wrapped with the pattern "${mark.pattern}", but its place under app/ routes it at "${pattern}"`;
  }
  return undefined;
}

/**
 * Rejects, through bun:test's `expect`, unless every handler every route file
 * under `appDirectory` exports is wrapped by request timing with the pattern
 * its place gives it, or is the envelope that carries procedures. Each route
 * module is imported, so the check reads what Next.js would run; a problem
 * names the file and the method.
 *
 * ```ts
 * test("every route handler is timed", () => requestTimingRoutesConform(join(import.meta.dir, "../app")));
 * ```
 */
export async function requestTimingRoutesConform(appDirectory: string): Promise<void> {
  const problems: string[] = [];
  const files = new Bun.Glob("**/route.{js,jsx,ts,tsx}").scan({ cwd: appDirectory });
  for await (const file of files) {
    const pattern = routePattern(file);
    if (pattern === undefined) continue;
    const route: unknown = await import(join(appDirectory, file));
    if (typeof route !== "object" || route === null) continue;
    for (const method of ROUTE_METHODS) {
      if (!(method in route)) continue;
      const exported: unknown = Object.getOwnPropertyDescriptor(route, method)?.value;
      const problem = handlerProblem(exported, pattern);
      if (problem !== undefined) problems.push(`${join(appDirectory, file)}: ${method} ${problem}`);
    }
  }
  expect(
    problems.toSorted(),
    "the route handlers request timing does not see as their routes",
  ).toEqual([]);
}
