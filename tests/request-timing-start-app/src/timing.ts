/**
 * Whether this instance of the fixture times its requests, and where its
 * records and faults go. `FIXTURE_TIMING=off` is the differential's oracle:
 * the same app with the bare client, the bare handler and no naming
 * middleware.
 */
import { requestTiming } from "../../../request-timing.ts";
import { faultLine, lines } from "../../request-timing-fixture.ts";

export const timed = process.env["FIXTURE_TIMING"] !== "off";

/** The operation whose record the sink refuses, by throwing, as a sink whose log has gone would. */
export const UNWRITTEN = "/unwritten";

const written = lines();

/** The next line the sink or the fault wrote, as an app's stdout would hold it. */
export const nextLine = written.next;

export const timing = requestTiming({
  fault: (error) => written.write(faultLine(error)),
  sink: (record) => {
    if (record.operation === UNWRITTEN) throw new Error("the sink refused the record");
    written.write(JSON.stringify({ service: "fixture", ...record }));
  },
});
