/**
 * The Next.js app `request-timing-next-app/` built once per run and booted as
 * production serves it, `bun --bun next start`, which is how the warehouse
 * runs, over a real MySQL and an outside service of the case's own. The
 * Next.js and tRPC connectors' suites share the build and boot an instance
 * each; booted with timing off it is the same app with the bare clients and no
 * wrapper, which the differentials take as their oracle.
 */
import { afterAll, beforeAll } from "bun:test";
import { join } from "node:path";

import { must } from "../narrowing.ts";
import type { TimingRecord, WaitKind } from "../request-timing.ts";
import { lines, recordsFrom } from "./request-timing-fixture.ts";
import { scratchDatabase } from "./request-timing-servers.ts";

/** The fixture app's directory. */
export const APP = join(import.meta.dir, "request-timing-next-app");

const NEXT = join(import.meta.dir, "..", "node_modules", ".bin", "next");

/** What a child of the suite runs with: production, as a deployed app, rather than the `test` bun test sets. */
const childEnvironment = (own: Record<string, string>) => ({
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  ...own,
});

let built: Promise<void> | undefined;

/** `next build` of the app, once per run, whichever suite asks first. */
function build(): Promise<void> {
  built ??= (async () => {
    const child = Bun.spawn(["bun", "--bun", NEXT, "build"], {
      cwd: APP,
      env: childEnvironment({}),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`next build of the fixture app failed:\n${out}\n${err}`);
  })();
  return built;
}

/** Splits a byte stream into lines, handing each to `line` as it completes. */
async function eachLine(stream: ReadableStream<Uint8Array>, line: (text: string) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end !== -1) {
      line(pending.slice(0, end));
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  }
}

/** Boots the built app on a free loopback port, with request timing on or off. */
export async function nextApp(timed: boolean) {
  await build();
  const database = await scratchDatabase();
  const outside = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => Response.json({ outside: new URL(request.url).pathname }),
  });
  const child = Bun.spawn(["bun", "--bun", NEXT, "start", "-p", "0", "-H", "127.0.0.1"], {
    cwd: APP,
    env: childEnvironment({
      FIXTURE_TIMING: timed ? "on" : "off",
      FIXTURE_DATABASE_URL: database.url,
      FIXTURE_OUTSIDE_URL: outside.url.href,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = lines();
  const listening = Promise.withResolvers<URL>();
  const ready = Promise.withResolvers<void>();
  const errors: string[] = [];
  void eachLine(child.stdout, (text) => {
    const local = /Local:\s+(\S+)/u.exec(text)?.[1];
    if (local !== undefined) listening.resolve(new URL(local));
    if (text.includes("Ready")) ready.resolve();
    sink.write(text);
  });
  void eachLine(child.stderr, (text) => void errors.push(text));
  void child.exited.then((status) => {
    const exited = new Error(`next start exited with ${status}:\n${errors.join("\n")}`);
    listening.reject(exited);
    ready.reject(exited);
  });
  let base: URL;
  try {
    base = await listening.promise;
    await ready.promise;
  } catch (error) {
    // `next start` exited before it served: take down what was made for it.
    await outside.stop(true);
    await database[Symbol.asyncDispose]();
    throw error;
  }

  /** Records read ahead of the case that asked for one by name. */
  const unclaimed: TimingRecord[] = [];
  const records = recordsFrom(sink.next);
  const nextRecord = records.next;

  return {
    url: (path: string) => new URL(path, base),
    /** The next line the server wrote, for the conformance kit. */
    nextLine: sink.next,
    /** The next record the server wrote, whichever operation it names. */
    nextRecord,
    /**
     * The next record naming `operation`, leaving every other record in the
     * order written for the next claim of its own name: the controls a case
     * drives beside the operation it grades write records of their own.
     */
    recordOf: async (operation: string): Promise<TimingRecord> => {
      const waiting = unclaimed.findIndex((record) => record.operation === operation);
      if (waiting !== -1) return must(unclaimed.splice(waiting, 1)[0]);
      for (;;) {
        const record = await nextRecord();
        if (record.operation === operation) return record;
        unclaimed.push(record);
      }
    },
    /**
     * Every record written before a sentinel request's and not yet claimed,
     * taken. Each record closes before its response ends, so a record of any
     * request answered before the sentinel was sent is among them.
     */
    settle: async (): Promise<TimingRecord[]> => {
      await (await fetch(new URL("/api/sentinel", base))).text();
      const before = unclaimed.splice(0);
      for (;;) {
        const record = await nextRecord();
        if (record.operation === "/api/sentinel") return before;
        before.push(record);
      }
    },
    /** The faults the app's `fault` wrote among the lines read so far, taken. */
    faults: records.faults,
    /** What the server wrote to its standard error. */
    errors: () => [...errors],
    [Symbol.asyncDispose]: async () => {
      child.kill();
      await child.exited;
      await outside.stop(true);
      await database[Symbol.asyncDispose]();
    },
  };
}

/** A booted fixture app. */
export type NextApp = Awaited<ReturnType<typeof nextApp>>;

/** One ending a case drives: what it is, the request, the record it closes into, and that record's wait counts. */
export type Ending = readonly [
  ending: string,
  path: string,
  init: RequestInit,
  expected: Partial<TimingRecord>,
  counts: Partial<Record<WaitKind, number>>,
];

/**
 * The differential: `script` sent, one request after the other, to `app` and
 * to the same app booted with timing off, each response read by `read`, and
 * both runs' records then taken from `app`.
 */
export async function differential<T>(
  app: NextApp,
  script: readonly (readonly [string, RequestInit])[],
  read: (response: Response) => Promise<T>,
) {
  const run = async (target: NextApp) => {
    const responses: T[] = [];
    for (const [path, init] of script)
      responses.push(await read(await fetch(target.url(path), init)));
    return responses;
  };
  await using off = await nextApp(false);
  const answers = { on: await run(app), off: await run(off) };
  await app.settle();
  return answers;
}

/**
 * The app with timing on, booted once for the suite that calls this and
 * stopped after it; `app` is it, from the first case on. The first suite of a
 * run to boot the app also builds it, which a cold `next build` takes tens of
 * seconds to do on a loaded box.
 */
export function bootedForSuite(): { readonly app: NextApp } {
  let booted: NextApp | undefined;
  beforeAll(async () => {
    booted = await nextApp(true);
  }, 300_000);
  afterAll(async () => {
    await booted?.[Symbol.asyncDispose]();
  });
  return {
    get app() {
      return must(booted);
    },
  };
}
