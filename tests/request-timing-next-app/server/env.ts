/**
 * What the suite hands the server it boots. The connections are read when a
 * request first needs them, so the conformance kit's route-tree check can load
 * every route module in the suite's own process, where none is set.
 */
import { required } from "../../../.github/actions/_lib/gate.ts";

const BOOTED = "the request-timing Next.js suite sets it when it boots the fixture app";

/** Whether request timing is on: the suite boots the app off as the differential's oracle. */
export const timed = Bun.env.FIXTURE_TIMING !== "off";

export const databaseUrl = () => required("FIXTURE_DATABASE_URL", BOOTED);

export const outsideUrl = () => required("FIXTURE_OUTSIDE_URL", BOOTED);
