/**
 * The request-timing conformance kit: an adopting app's own suite runs it
 * against its own booted server, to show that one request for an operation
 * which makes a known number of database waits is answered by exactly one
 * record carrying that number.
 *
 * ```ts
 * test("request timing", () =>
 *   requestTimingConforms({
 *     method: "GET",
 *     operation: "/presets/:id",
 *     dbWaits: 2,
 *     drive: async () => void (await (await fetch(`${server.url}presets/1`)).text()),
 *     next: () => lines.next(),
 *     sentinel: {
 *       operation: "/health",
 *       drive: async () => void (await (await fetch(`${server.url}health`)).text()),
 *     },
 *   }));
 * ```
 *
 * "Exactly one" needs a point after which the request can have written
 * nothing more, and a record carries nothing that tells one request's from
 * another's, so the kit takes a second operation of the same server, the
 * sentinel, as that point. It drives the sentinel and reads up to its record,
 * so whatever the server wrote before the kit began is behind it; drives the
 * operation; drives the sentinel again; and requires the records between the
 * two sentinel records to be exactly one, of the method and operation named,
 * with `dbWaits` database waits. A server that writes two records for one
 * request, whatever they hold, fails it, and so does one that misses a wait or
 * names the operation by its URL. Its one assumption is that a record is
 * written by the time the server has answered a later request. A server that
 * writes no record leaves `next` waiting, and the test fails at its timeout.
 */
import { expect } from "bun:test";
import { join } from "node:path";

import type { Method, TimingRecord } from "./request-timing-operation.ts";
import { markOf } from "./request-timing-route.ts";
import { parseRecord } from "./request-timing-summary.ts";

/** One operation of the app's booted server, a second one to read up to, and the way to read what its sink writes. */
export interface ConformanceTarget {
  readonly method: Method;
  /** The name the router registered for the operation, as the record carries it. */
  readonly operation: string;
  /** How many database waits one request for the operation makes. */
  readonly dbWaits: number;
  /** Sends one request for the operation, resolving once its response has been read to the end. */
  readonly drive: () => Promise<void>;
  /** Resolves with the next line the server's sink writes, in the order written. */
  readonly next: () => Promise<string>;
  /** Another operation of the same server, under another name, that the kit reads up to. Nothing else may reach the server while the kit runs. */
  readonly sentinel: {
    readonly operation: string;
    /** Sends one request for it, resolving once its response has been read to the end. */
    readonly drive: () => Promise<void>;
  };
}

/** Drives the sentinel and answers every record read before the sentinel's own. */
async function readToSentinel(target: ConformanceTarget): Promise<TimingRecord[]> {
  await target.sentinel.drive();
  const before: TimingRecord[] = [];
  for (;;) {
    const record = parseRecord(await target.next());
    if (record?.operation === target.sentinel.operation) return before;
    if (record !== undefined) before.push(record);
  }
}

/** Rejects, through bun:test's `expect`, unless one request for the operation is answered by exactly one record, carrying `dbWaits`. */
export async function requestTimingConforms(target: ConformanceTarget): Promise<void> {
  if (target.sentinel.operation === target.operation) {
    throw new Error(
      `requestTimingConforms reads up to a sentinel operation, and was given ${target.operation} as both: name another operation of the server`,
    );
  }
  await readToSentinel(target);
  await target.drive();
  const written = await readToSentinel(target);
  expect(
    written.map((record) => ({
      method: record.method,
      operation: record.operation,
      dbWaits: record.db.count,
    })),
    "the records one request was answered by",
  ).toEqual([{ method: target.method, operation: target.operation, dbWaits: target.dbWaits }]);
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
 * The functions of `next/navigation` that end a handler by throwing, which
 * Next.js answers with a status of its own (404, 307 or 308, 403, 401) by
 * means it does not make public, so the route wrapper records 500.
 */
const THROWN_ANSWERS = ["notFound", "redirect", "permanentRedirect", "forbidden", "unauthorized"];

/** The imports from `next/navigation` a route's source writes: every name, or `*` for the whole module. */
const NAVIGATION_IMPORT =
  /import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+["']next\/navigation["']/gu;

/**
 * Which of `THROWN_ANSWERS` a route's source imports from `next/navigation`,
 * by the name it exports them under; all of them for the whole module.
 */
function thrownAnswers(source: string): string[] {
  const found = new Set<string>();
  for (const [, clause = ""] of source.matchAll(NAVIGATION_IMPORT)) {
    if (clause.startsWith("*")) return THROWN_ANSWERS;
    for (const imported of clause.slice(1, -1).split(",")) {
      const name = imported.trim().split(/\s+/u)[0] ?? "";
      if (THROWN_ANSWERS.includes(name)) found.add(name);
    }
  }
  return [...found];
}

/**
 * Rejects, through bun:test's `expect`, unless every handler every route file
 * under `appDirectory` exports is wrapped by request timing with the pattern
 * its place gives it, or is the envelope that carries procedures, and no route
 * file imports one of the `next/navigation` functions whose answer its record
 * would get wrong. Each route module is imported, so the check reads what
 * Next.js would run; a problem names the file, and the method where it is one
 * handler's.
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
    const thrown = thrownAnswers(await Bun.file(join(appDirectory, file)).text());
    if (thrown.length > 0) {
      problems.push(
        `${join(appDirectory, file)}: imports ${thrown.join(", ")} from next/navigation, which ends a handler with a status its record says is 500; return the response instead`,
      );
      continue;
    }
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
