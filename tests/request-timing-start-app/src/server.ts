/**
 * The server entry, as the template's `src/server.ts` has it, with the
 * handler timed; and what the suite reaches into the running app through.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { timedStartHandler } from "../../../request-timing-tanstack-start.ts";
import {
  aServerFunctionWhoseFileAndVariableTogetherRunPastTheLongestNameTheCoreTakesForARecordWhichIsTwoHundredAndFiftySixCharactersSoItsOperationMeetsTheRefusalOnlyWhenItsFirstCallClosesAndThatRefusalGoesToTheAppsFaultLeavingNoRecordAndTheCallItselfServedAsUsual as refusedFn,
  failingFn,
  listPresetsFn,
  streamingFn,
} from "./fns.ts";
import { arrived, held, holdPermit } from "./presets.ts";
import { getRouter, inProcess } from "./router.ts";
import { runtime } from "./runtime.ts";
import { nextLine, timed, timing } from "./timing.ts";

const handler = createStartHandler(defaultStreamHandler);

const served = timed ? timedStartHandler(timing, handler, getRouter) : handler;

inProcess.handle = (request) => served(request);

export default { fetch: served };

/** The suite's way into the running app. */
export const fixture = {
  nextLine,
  held,
  arrived,
  /** Takes the lanes' permit outside every operation, answering what gives it back. */
  hold: async () => {
    const release = await runtime.runPromise(holdPermit);
    return () => runtime.runPromise(release);
  },
  /** Where each server function is called over HTTP. */
  urls: {
    list: listPresetsFn.url,
    failing: failingFn.url,
    streaming: streamingFn.url,
    refused: refusedFn.url,
  },
};
