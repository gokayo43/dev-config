/**
 * The request-timing reader: what it makes of a mixed log, the one schema it
 * reads (invariant 7), and the bin's statuses, which are its contract with the
 * agent that pipes a log through it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { TimingRecord } from "../request-timing.ts";
import {
  NO_RECORD,
  parseRecord,
  Reader,
  SUMMARISED,
  UNREADABLE,
} from "../request-timing-summary.ts";

/** What a log line's JSON can hold, wrong types included. */
type Json = string | number | boolean | undefined | { readonly [key: string]: Json };

const record = (
  fields: { readonly [Field in keyof TimingRecord]?: Json } & { readonly service?: string },
) =>
  JSON.stringify({
    requestTiming: 1,
    at: "2026-11-17T09:00:00.000Z",
    method: "GET",
    operation: "/presets/:id",
    status: 200,
    totalMs: 10,
    inFlightMs: 0,
    db: { waitMs: 0, count: 0 },
    out: { waitMs: 0, count: 0 },
    store: { waitMs: 0, count: 0 },
    aborted: false,
    streamed: false,
    ...fields,
  });

/** A week of an app's stdout: records among its other JSON lines and lines that are not JSON. */
const LOG = [
  "listening on :3000",
  record({
    at: "2026-11-16T23:59:59.999Z",
    totalMs: 10,
    inFlightMs: 6,
    db: { waitMs: 4, count: 2 },
    store: { waitMs: 1, count: 1 },
    service: "api",
  }),
  JSON.stringify({ level: "info", msg: "cache warmed", requestTimingNote: "not a record" }),
  record({
    totalMs: 30,
    inFlightMs: 20,
    db: { waitMs: 16, count: 6 },
    out: { waitMs: 8, count: 1 },
    aborted: true,
    status: 499,
  }),
  '{"requestTiming": 1, "truncated',
  record({ method: "POST", operation: "/orders", totalMs: 5, status: 201 }),
  record({
    operation: "/export",
    totalMs: 60_000,
    inFlightMs: 1_000,
    db: { waitMs: 1_000, count: 1 },
    streamed: true,
  }),
  "",
];

const read = (lines: readonly string[]) => {
  const reader = new Reader();
  for (const line of lines) reader.add(line);
  return reader.summary();
};

describe("the reader", () => {
  test("sums each operation's records and ranks streamed ones apart", () => {
    expect(read(LOG)).toEqual({
      lines: 7,
      records: 4,
      days: [
        { day: "2026-11-16", records: 1 },
        { day: "2026-11-17", records: 3 },
      ],
      operations: [
        {
          method: "GET",
          operation: "/presets/:id",
          streamed: false,
          count: 2,
          aborted: 1,
          totalMs: 40,
          meanMs: 20,
          shares: { db: 0.5, out: 0.2, store: 0.025, rest: 0.35 },
          waitsPerOperation: { db: 4, out: 0.5, store: 0.5 },
        },
        {
          method: "POST",
          operation: "/orders",
          streamed: false,
          count: 1,
          aborted: 0,
          totalMs: 5,
          meanMs: 5,
          shares: { db: 0, out: 0, store: 0, rest: 1 },
          waitsPerOperation: { db: 0, out: 0, store: 0 },
        },
      ],
      streamed: [
        {
          method: "GET",
          operation: "/export",
          streamed: true,
          count: 1,
          aborted: 0,
          totalMs: 60_000,
          meanMs: 60_000,
          shares: { db: 1_000 / 60_000, out: 0, store: 0, rest: 59_000 / 60_000 },
          waitsPerOperation: { db: 1, out: 0, store: 0 },
        },
      ],
    });
  });

  test("stops on a record of a schema version it does not know, naming the version and the line", () => {
    expect(() => read([record({}), record({ requestTiming: 2 })])).toThrow(
      "line 2 is a record of schema version 2; this reader knows version 1 alone",
    );
  });

  const broken: readonly [string, Parameters<typeof record>[0]][] = [
    ["at", { at: "yesterday" }],
    ["method", { method: "PROPFIND" }],
    ["status", { status: 42 }],
    ["totalMs", { totalMs: -1 }],
    ["inFlightMs", { inFlightMs: 11 }],
    ["db", { db: { waitMs: 1 } }],
    ["store", { store: { waitMs: 1, count: 0.5 } }],
    ["aborted", { aborted: "no" }],
    ["operation", { operation: undefined }],
  ];
  for (const [field, fields] of broken) {
    test(`stops on a version 1 record whose ${field} is not one`, () => {
      expect(() => parseRecord(record(fields))).toThrow(`record whose ${field} is`);
    });
  }
});

/** Runs the bin over `input`, as an agent at a terminal does. */
async function report(input: string, args: readonly string[] = []) {
  const run = Bun.spawn(["bun", join(import.meta.dir, "..", "request-timing-report.ts"), ...args], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { stdout, stderr, status };
}

describe("the reader's command", () => {
  test("prints the summary, with streamed operations under their own heading", async () => {
    const { stdout, status } = await report(LOG.join("\n"));
    expect(status).toBe(SUMMARISED);
    expect(stdout).toContain("4 records in 7 lines");
    expect(stdout).toContain("  2026-11-16  1");
    expect(stdout.indexOf("/presets/:id")).toBeLessThan(stdout.indexOf("/orders"));
    expect(stdout.indexOf("streamed operations")).toBeLessThan(stdout.indexOf("/export"));
  });

  test("answers --json with the summary an agent parses", async () => {
    const { stdout, status } = await report(LOG.join("\n"), ["--json"]);
    expect(status).toBe(SUMMARISED);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(read(LOG))));
  });

  test("exits with its own status on a log that holds no record", async () => {
    const { stdout, stderr, status } = await report('listening on :3000\n{"level":"info"}\n');
    expect({ status, stdout }).toEqual({ status: NO_RECORD, stdout: "" });
    expect(stderr).toContain("no record in 2 lines");
  });

  test("exits unreadable on a schema version it does not know", async () => {
    const { stderr, status } = await report(record({ requestTiming: 3 }));
    expect(status).toBe(UNREADABLE);
    expect(stderr).toContain("schema version 3");
  });
});
