import { describe, expect, test } from "bun:test";

import { record } from "../.github/actions/_lib/gate.ts";

/**
 * The composite around the gates, rather than a gate. Every other suite here
 * drives a module against a fixture; what this one is about is the wiring that
 * decides whether a failing run leaves anything to read — and that lives in
 * YAML no module can be handed.
 *
 * The db-gate writes its evidence into the runner's temp directory: the app's
 * own output, the two route-log snapshots the floor subtracts, and the k6
 * summary. The runner is deleted when the job ends, so a file that is not
 * uploaded is a diagnostic that exists only while nobody needs it.
 *
 * Scoped to this action deliberately. The other actions fetch pinned binaries
 * into the same directory — k6, actionlint, gitleaks — and a tool is not
 * evidence, so a rule over all of them would be a rule with a list of
 * exceptions.
 */
const ACTION = new URL("../.github/actions/db-gate/action.yml", import.meta.url).pathname;

const document = Bun.YAML.parse(await Bun.file(ACTION).text());
const declared = record(record(document)["runs"])["steps"];
const steps: unknown[] = Array.isArray(declared) ? declared : [];

const uploadAt = steps.findIndex((step) => {
  const uses = record(step)["uses"];
  return typeof uses === "string" && uses.includes("upload-artifact");
});

/** Both spellings of the runner's temp directory: bash's variable, and the expression a `with:` uses. */
const TEMP_PATH = /(?:\$RUNNER_TEMP|\$\{\{ ?runner\.temp ?\}\})\/([\w./-]+)/g;

/**
 * Every string in the document, wherever it sits. Read off the parsed YAML the
 * way `pins.ts` reads a `uses:` rather than grepped out of the serialised
 * document: a value that is quoted, folded or nested somewhere a pattern did
 * not anticipate is the same leaf to a parser and another hole in a regex.
 */
function stringsIn(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (typeof node !== "object" || node === null) return [];
  return Object.values(record(node)).flatMap(stringsIn);
}

/**
 * The runner-temp paths a node names — which is not the same as the paths it
 * writes, and is the looser of the two on purpose: a step that only reads or
 * prints one still counts, so the requirement can only ever be too strict, and
 * a file this action mentions and does not keep is the thing being looked for.
 */
function tempPathsIn(node: unknown): string[] {
  return stringsIn(node).flatMap((text) =>
    [...text.matchAll(TEMP_PATH)].map(([, path]) => path ?? ""),
  );
}

function sorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].toSorted((a, b) => a.localeCompare(b));
}

describe("the database gate's own wiring", () => {
  test("the steps are readable, and one of them uploads", () => {
    expect(steps.length).toBeGreaterThan(0);
    expect(uploadAt).toBeGreaterThanOrEqual(0);
  });

  // The floor's annotation names the route that went unexercised; what the app
  // declared, what the ramp reached, and what the app said while it ran are in
  // these files. Reproducing a failure by re-running it with more printing is
  // the shape of debugging every diagnostic in this repo exists to avoid.
  test("every runner-temp path this action names leaves the run", () => {
    // By position rather than by identity: `record` hands back the object it
    // was given, so identity happens to work and would stop working the day it
    // copied.
    const named = steps.filter((_, index) => index !== uploadAt).flatMap(tempPathsIn);
    const kept = tempPathsIn(record(record(steps[uploadAt])["with"])["path"]);
    expect(sorted(kept)).toEqual(sorted(named));
  });

  // A run that passed has nothing to investigate. The condition is what makes
  // the upload a diagnostic rather than a souvenir: it has to survive the step
  // before it failing, and a cancelled run has nothing to say.
  test("the upload survives the step that failed before it", () => {
    expect(record(steps[uploadAt])["if"]).toBe("${{ !cancelled() }}");
  });
});
