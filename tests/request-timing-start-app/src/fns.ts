/**
 * The fixture's server functions, each running an Effect program through the
 * one bridge: a plain answer, one that throws after its wait, and one that
 * streams its answer with a wait between the parts.
 */
import { createServerFn } from "@tanstack/react-start";

import { listPresets } from "./presets.ts";
import { run } from "./runtime.ts";

/** A refusal the server function throws, which Start answers with 500. */
class Refused extends Error {}

export const listPresetsFn = createServerFn({ method: "GET" }).handler(() => run(listPresets));

export const failingFn = createServerFn({ method: "GET" }).handler(async () => {
  await run(listPresets);
  throw new Refused("refused midway");
});

async function* parts() {
  yield "first";
  const rows = await run(listPresets);
  yield `then ${rows.length}`;
}

export const streamingFn = createServerFn({ method: "GET" }).handler(() => parts());

/**
 * A server function whose record name, its file and its variable, is longer
 * than the core takes: the one refused name Start can make at a request, met
 * when the call closes.
 */
export const aServerFunctionWhoseFileAndVariableTogetherRunPastTheLongestNameTheCoreTakesForARecordWhichIsTwoHundredAndFiftySixCharactersSoItsOperationMeetsTheRefusalOnlyWhenItsFirstCallClosesAndThatRefusalGoesToTheAppsFaultLeavingNoRecordAndTheCallItselfServedAsUsual =
  createServerFn({ method: "GET" }).handler(() => "served");
