/**
 * Whether this instance of the fixture times its requests, and where its
 * records go. `REQUEST_TIMING=off` is the differential's oracle: the same app
 * with the bare client, the bare handler and no naming middleware.
 */
import { requestTiming } from "../../../request-timing.ts";
import { lines } from "../../request-timing-fixture.ts";

export const timed = process.env["REQUEST_TIMING"] !== "off";

const written = lines();

/** The next line the sink wrote, as an app's stdout would hold it. */
export const nextLine = written.next;

export const timing = requestTiming({
  fault: (error) => {
    throw error;
  },
  sink: (record) => written.write(JSON.stringify({ service: "fixture", ...record })),
});
