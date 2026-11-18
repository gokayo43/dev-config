/**
 * The booted servers `request-timing-conformance.test.ts` grades the kit
 * against: one per carrier that adopts the export as its page says, and one
 * per way of adopting it wrongly that the kit names. Each serves
 * `GET /presets/:id` with two database waits, and its sink writes each record
 * as a JSON line after a log line of its own, as an app's stdout would hold.
 */
import { Effect } from "effect";

import * as effectCarrier from "../request-timing-effect.ts";
import * as plainCarrier from "../request-timing.ts";
import { methodOf, OperationName, requestTiming } from "../request-timing.ts";

export const DB_WAITS = 2;
export const PATTERN = "/presets/:id";

/** How the server adopts the export. */
export type Adoption =
  | "plain"
  | "effect"
  /** One of the two queries is not measured. */
  | "uncounted"
  /** A second operation is opened around the handler's. */
  | "doubled"
  /** The operation is named by the request's path rather than the route. */
  | "misnamed";

/** Lines in the order the sink writes them, taken one at a time. */
function lines() {
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

const query = async () => [{ id: 1 }];

/** Serves `/presets/:id` on a free loopback port, adopting the export as `adoption` says. */
export function presetServer(adoption: Adoption) {
  const sink = lines();
  const timing = requestTiming({
    sink: (record) => {
      sink.write(JSON.stringify({ level: "info", msg: "served" }));
      sink.write(JSON.stringify({ service: "fixture", ...record }));
    },
  });
  const handlePlain = async (measured: number) => {
    for (let index = 0; index < DB_WAITS; index += 1) {
      await (index < measured ? plainCarrier.measure("db", query) : query());
    }
    return Response.json({ id: 1 });
  };
  const handleEffect = Effect.gen(function* () {
    for (let index = 0; index < DB_WAITS; index += 1) {
      yield* effectCarrier.measure("db", Effect.promise(query));
    }
    return Response.json({ id: 1 });
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      [PATTERN]: async (request) => {
        const path = new URL(request.url).pathname;
        const close = (operation: plainCarrier.Operation, status: number, name = PATTERN) =>
          operation.close({
            method: methodOf(request.method),
            name: OperationName.registered(name),
            status,
            aborted: false,
            streamed: false,
          });
        const operation = timing.open();
        if (adoption === "effect") {
          const response = await Effect.runPromise(effectCarrier.within(operation, handleEffect));
          close(operation, response.status);
          return response;
        }
        if (adoption === "doubled") {
          const outer = timing.open();
          const response = await plainCarrier.within(outer, () =>
            plainCarrier.within(operation, () => handlePlain(DB_WAITS)),
          );
          close(operation, response.status);
          close(outer, response.status);
          return response;
        }
        const response = await plainCarrier.within(operation, () =>
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
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}
