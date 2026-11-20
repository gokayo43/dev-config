/**
 * The booted servers `request-timing-conformance.test.ts` grades the kit
 * against: a plain handler and one that runs an Effect program, each adopting
 * the export as its page says, and one per way of adopting it wrongly that
 * the kit names. Each serves `GET /presets/:id` with two database waits, and
 * its sink writes each record as a JSON line after a log line of its own, as
 * an app's stdout would hold.
 */
import { Effect } from "effect";

import { parseRecord } from "../request-timing-summary.ts";
import {
  measure,
  methodOf,
  type Operation,
  OperationName,
  requestTiming,
  type TimingRecord,
  within,
} from "../request-timing.ts";

export const DB_WAITS = 2;
export const PATTERN = "/presets/:id";
/** The operation the kit reads up to, served the same way by every adoption. */
export const SENTINEL = "/health";

/** How the server adopts the export. */
export type Adoption =
  | "plain"
  | "effect"
  /** One of the two queries is not measured. */
  | "uncounted"
  /** A second operation is opened around the handler's. */
  | "doubled"
  /** The operation is named by the request's path rather than the route. */
  | "misnamed"
  /** The sink writes every record twice, as two copies of the export in one process would. */
  | "echoed"
  /** Two operations are opened and closed for each request, one after the other, each counting both queries. */
  | "twice";

/** Lines in the order the sink writes them, taken one at a time. */
export function lines() {
  const written: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  return {
    write: (line: string) => {
      const taker = waiting.shift();
      if (taker === undefined) written.push(line);
      else taker(line);
    },
    next: () => {
      const line = written.shift();
      return line === undefined
        ? new Promise<string>((resolve) => waiting.push(resolve))
        : Promise.resolve(line);
    },
  };
}

/**
 * The line a fixture's `fault` writes beside its records, as an app logs a
 * fault: the error's message, under `fault`.
 */
export const faultLine = (error: unknown): string =>
  JSON.stringify({ fault: error instanceof Error ? error.message : String(error) });

/**
 * The records among the lines `next` hands over, one at a time, with every
 * fault line read past on the way kept for `faults`. Other lines are skipped.
 */
export function recordsFrom(next: () => Promise<string>) {
  const faults: string[] = [];
  return {
    next: async (): Promise<TimingRecord> => {
      for (;;) {
        const line = await next();
        const record = parseRecord(line);
        if (record !== undefined) return record;
        const parsed: unknown = line.startsWith("{") ? JSON.parse(line) : undefined;
        if (typeof parsed === "object" && parsed !== null && "fault" in parsed) {
          faults.push(String(parsed.fault));
        }
      }
    },
    /** The faults read past so far, taken. */
    faults: () => faults.splice(0),
  };
}

/**
 * A response as a client reads it, less the one header that differs by the
 * second it was sent, with its body read by `body`: as text, unless a case
 * reads bytes or masks what differs by the moment it was made.
 */
export async function read(
  response: Response,
  body: (response: Response) => Promise<unknown> = (sent) => sent.text(),
) {
  const headers = [...response.headers].filter(([name]) => name !== "date");
  return { status: response.status, headers, body: await body(response) };
}

/**
 * A latch a handler waits on midway, so a case can leave while the handler is
 * provably waiting and then let it finish. One handler at a time.
 */
export function latch() {
  let reached = Promise.withResolvers<void>();
  let opened = Promise.withResolvers<void>();
  let finished = Promise.withResolvers<void>();
  return {
    /** What a handler awaits midway. */
    wait: () => {
      reached.resolve();
      return opened.promise;
    },
    /** Called by the handler once it has done everything after the wait. */
    done: () => finished.resolve(),
    /** Resolves once a handler is waiting. */
    reached: () => reached.promise,
    /** Lets the waiting handler on, and resolves once it has called `done`. */
    open: async () => {
      const waiting = finished;
      opened.resolve();
      await waiting.promise;
      reached = Promise.withResolvers<void>();
      opened = Promise.withResolvers<void>();
      finished = Promise.withResolvers<void>();
    },
  };
}

const query = async () => [{ id: 1 }];

const handlePlain = async (measured: number) => {
  for (let index = 0; index < DB_WAITS; index += 1) {
    await (index < measured ? measure("db", query) : query());
  }
  return Response.json({ id: 1 });
};

/** Serves `/presets/:id` on a free loopback port, adopting the export as `adoption` says. */
export function presetServer(adoption: Adoption) {
  const sink = lines();
  const timing = requestTiming({
    fault: (error) => sink.write(faultLine(error)),
    sink: (record) => {
      sink.write(JSON.stringify({ level: "info", msg: "served" }));
      sink.write(JSON.stringify({ service: "fixture", ...record }));
      if (adoption === "echoed") sink.write(JSON.stringify({ service: "fixture", ...record }));
    },
  });
  const handleEffect = Effect.gen(function* () {
    for (let index = 0; index < DB_WAITS; index += 1) {
      yield* Effect.promise(() => measure("db", query));
    }
    return Response.json({ id: 1 });
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      [SENTINEL]: async (request) => {
        const operation = timing.open();
        const response = await within(operation, async () => new Response("ok"));
        operation.close({
          method: methodOf(request.method),
          name: OperationName.registered(SENTINEL),
          status: response.status,
          aborted: false,
          streamed: false,
        });
        return response;
      },
      [PATTERN]: async (request) => {
        const path = new URL(request.url).pathname;
        const close = (operation: Operation, status: number, name = PATTERN) =>
          operation.close({
            method: methodOf(request.method),
            name: OperationName.registered(name),
            status,
            aborted: false,
            streamed: false,
          });
        const operation = timing.open();
        if (adoption === "effect") {
          const response = await within(operation, () => Effect.runPromise(handleEffect));
          close(operation, response.status);
          return response;
        }
        if (adoption === "twice") {
          await within(operation, () => handlePlain(DB_WAITS));
          close(operation, 200);
          const again = timing.open();
          const response = await within(again, () => handlePlain(DB_WAITS));
          close(again, response.status);
          return response;
        }
        if (adoption === "doubled") {
          const outer = timing.open();
          const response = await within(outer, () =>
            within(operation, () => handlePlain(DB_WAITS)),
          );
          close(operation, response.status);
          close(outer, response.status);
          return response;
        }
        const response = await within(operation, () =>
          handlePlain(adoption === "uncounted" ? DB_WAITS - 1 : DB_WAITS),
        );
        close(operation, response.status, adoption === "misnamed" ? path : PATTERN);
        return response;
      },
    },
  });
  return {
    drive: async () => void (await (await fetch(new URL("/presets/42", server.url))).text()),
    next: sink.next,
    sentinel: {
      operation: SENTINEL,
      drive: async () => void (await (await fetch(new URL(SENTINEL, server.url))).text()),
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}
