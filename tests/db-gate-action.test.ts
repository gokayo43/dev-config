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
 */
const ACTION = new URL("../.github/actions/db-gate/action.yml", import.meta.url).pathname;

const document = Bun.YAML.parse(await Bun.file(ACTION).text());
const declared = record(record(document)["runs"])["steps"];
const steps: unknown[] = Array.isArray(declared) ? declared : [];

const upload = steps.map(record).find((step) => {
  const uses = step["uses"];
  return typeof uses === "string" && uses.includes("upload-artifact");
});

/** Both spellings of the runner's temp directory: bash's variable, and the expression a `with:` uses. */
const TEMP_FILE = /(?:\$RUNNER_TEMP|\$\{\{ ?runner\.temp ?\}\})\/([\w.-]+)/g;

function tempFilesIn(node: unknown): string[] {
  return [...JSON.stringify(node).matchAll(TEMP_FILE)].map(([, file]) => file ?? "");
}

function sorted(files: Iterable<string>): string[] {
  return [...new Set(files)].toSorted((a, b) => a.localeCompare(b));
}

describe("the database gate's own wiring", () => {
  test("the steps are readable, and one of them uploads", () => {
    expect(steps.length).toBeGreaterThan(0);
    expect(upload).toBeDefined();
  });

  // The floor's annotation names the route that went unexercised; what the app
  // declared, what the ramp reached, and what the app said while it ran are in
  // these files. Reproducing a failure by re-running it with more printing is
  // the shape of debugging every diagnostic in this repo exists to avoid.
  test("every file the gate writes into the runner's temp leaves the run", () => {
    const written = steps.filter((step) => step !== upload).flatMap(tempFilesIn);
    const kept = tempFilesIn(record(record(upload)["with"])["path"]);
    expect(sorted(kept)).toEqual(sorted(written));
  });

  // A run that passed has nothing to investigate. The condition is what makes
  // the upload a diagnostic rather than a souvenir: it has to survive the step
  // before it failing, and a cancelled run has nothing to say.
  test("the upload survives the step that failed before it", () => {
    expect(record(upload)["if"]).toBe("${{ !cancelled() }}");
  });
});
