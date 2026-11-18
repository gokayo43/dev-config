/**
 * The `fetch` connector against a real server on a loopback port: one `out`
 * wait per call, ended when the headers arrive, and a call whose answer,
 * failure and body are what the bare `fetch` gives.
 */
import { describe, expect, test } from "bun:test";

import { only, rejectionOf } from "../narrowing.ts";
import { timedFetch } from "../request-timing-fetch.ts";
import { OperationName, requestTiming, type TimingRecord, within } from "../request-timing.ts";
import { counted, NONE } from "./request-timing-oracle.ts";

/**
 * An outside service: `/json` answers at once, and `/held` sends its headers
 * and then holds its body until the case releases it.
 */
function outsideService() {
  const held = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/json": () => Response.json({ served: true }, { headers: { "x-from": "outside" } }),
      "/held": () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode("first,")),
            pull: async (controller) => {
              await held.promise;
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            },
          }),
        ),
    },
  });
  return {
    url: (path: string) => new URL(path, server.url),
    release: () => held.resolve(),
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

describe("the fetch connector", () => {
  test("changes nothing a caller reads off the response", async () => {
    await using service = outsideService();
    const read = async (send: typeof fetch) => {
      const response = await send(service.url("/json"));
      return {
        status: response.status,
        from: response.headers.get("x-from"),
        body: await response.json(),
      };
    };
    const off = await read(fetch);
    const on = await counted(() => read(timedFetch(fetch)));
    expect(on.answer).toEqual(off);
    expect(on.counts).toEqual({ ...NONE, out: 1 });
  });

  test("counts a call that fails, and fails it as the bare fetch does", async () => {
    await using service = outsideService();
    const gone = service.url("/json");
    await service[Symbol.asyncDispose]();
    const off = await rejectionOf(fetch(gone), Error);
    const on = await counted(() => rejectionOf(timedFetch(fetch)(gone), Error));
    expect(on.answer.message).toBe(off.message);
    expect(on.counts).toEqual({ ...NONE, out: 1 });
  });

  test("ends the wait when the headers arrive, so reading the body is the rest", async () => {
    await using service = outsideService();
    let at = 0;
    const records: TimingRecord[] = [];
    const operation = requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: (record) => void records.push(record),
      now: () => at,
    }).open();
    const send = timedFetch(fetch);
    const body = await within(operation, async () => {
      const response = await send(service.url("/held"));
      at = 100;
      service.release();
      return response.text();
    });
    operation.close({
      method: "GET",
      name: OperationName.registered("/held"),
      status: 200,
      aborted: false,
      streamed: false,
    });
    expect(body).toBe("first,second");
    expect(only(records)).toMatchObject({
      totalMs: 100,
      out: { waitMs: 0, count: 1 },
      inFlightMs: 0,
    });
  });

  test("keeps fetch's preconnect", () => {
    expect(timedFetch(fetch).preconnect).toBe(fetch.preconnect);
  });
});
