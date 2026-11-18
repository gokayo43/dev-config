/**
 * The conformance kit against a booted server per carrier, which must pass it,
 * and against each wrong adoption the kit names, which must fail it.
 */
import { describe, expect, test } from "bun:test";

import { requestTimingConforms } from "../request-timing-conformance.ts";
import { type Adoption, DB_WAITS, PATTERN, presetServer } from "./request-timing-fixture.ts";

const conforms = async (adoption: Adoption) => {
  await using server = presetServer(adoption);
  await requestTimingConforms({
    method: "GET",
    operation: PATTERN,
    dbWaits: DB_WAITS,
    drive: server.drive,
    next: server.next,
  });
};

describe("the conformance kit", () => {
  test("passes a plain async server", () => conforms("plain"));

  test("passes an Effect server", () => conforms("effect"));

  for (const adoption of ["uncounted", "doubled", "misnamed"] as const) {
    test(`fails a ${adoption} adoption`, async () => {
      await expect(conforms(adoption)).rejects.toThrow("the record the");
    });
  }

  test("refuses an operation that makes no database wait", async () => {
    await expect(
      requestTimingConforms({
        method: "GET",
        operation: PATTERN,
        dbWaits: 0,
        drive: async () => undefined,
        next: async () => "",
      }),
    ).rejects.toThrow("at least one database wait");
  });
});
