import { describe, expect, test } from "bun:test";

import { record } from "../.github/actions/_lib/gate.ts";

/**
 * The composites around the gates, rather than a gate. Every other suite here
 * drives a module against a fixture; what this one is about is the wiring that
 * decides whether a failing run leaves anything to read — and that lives in
 * YAML no module can be handed.
 *
 * An action writes its evidence into the runner's temp directory, and the
 * runner is deleted when the job ends: a file that is not uploaded is a
 * diagnostic that exists only while nobody needs it.
 *
 * Which actions are held to that is decided by the actions themselves rather
 * than by a list here: an action that uploads anything has said it has
 * something worth keeping, so it keeps all of it. The ones that fetch a pinned
 * binary into the same directory — actionlint, gitleaks — publish nothing and
 * are not selected, and no exception names them. The day one of them starts
 * publishing, it is held to the same rule without an edit here.
 */
const ACTIONS = new URL("../.github/actions/", import.meta.url).pathname;

const FILES = [...new Bun.Glob("*/action.yml").scanSync({ cwd: ACTIONS })].toSorted((a, b) =>
  a.localeCompare(b),
);

/** Both spellings of the runner's temp directory in bash, and the expression a `with:` uses. */
const TEMP_PATH = /(?:\$\{?RUNNER_TEMP\}?|\$\{\{ ?runner\.temp ?\}\})\/([\w./-]+)/g;

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
 * a file an action mentions and does not keep is the thing being looked for.
 */
function tempPathsIn(node: unknown): string[] {
  return stringsIn(node).flatMap((text) =>
    [...text.matchAll(TEMP_PATH)].map(([, path]) => path ?? ""),
  );
}

function sorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].toSorted((a, b) => a.localeCompare(b));
}

function isUpload(step: unknown): boolean {
  const uses = record(step)["uses"];
  return typeof uses === "string" && uses.includes("upload-artifact");
}

interface Action {
  readonly name: string;
  /** The steps that upload, and everything else, split once so each case reads one of them. */
  readonly uploads: unknown[];
  readonly rest: unknown[];
}

async function actionIn(file: string): Promise<Action> {
  const document = Bun.YAML.parse(await Bun.file(`${ACTIONS}${file}`).text());
  const declared = record(record(document)["runs"])["steps"];
  const steps: unknown[] = Array.isArray(declared) ? declared : [];
  return {
    name: file.replace("/action.yml", ""),
    uploads: steps.filter(isUpload),
    rest: steps.filter((step) => !isUpload(step)),
  };
}

const actions = await Promise.all(FILES.map(actionIn));

/** An action that uploads anything has said it has evidence; that is the whole of the selection. */
const publishing = actions.filter(({ uploads }) => uploads.length > 0);

describe("what a published action keeps", () => {
  test("the suite found the actions to ask", () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(publishing.length).toBeGreaterThan(0);
    expect(publishing.length).toBeLessThan(actions.length);
  });

  // A gate's annotation names the verdict; what is behind it — what the app
  // declared, which routes the ramp reached, which test skipped — is in these
  // files. Reproducing a failure by re-running it with more printing is the
  // shape of debugging every diagnostic in this repo exists to avoid.
  test.each(publishing)("$name keeps every runner-temp path it names", ({ uploads, rest }) => {
    const named = rest.flatMap(tempPathsIn);
    const kept = uploads.flatMap((step) => tempPathsIn(record(record(step)["with"])["path"]));
    expect(sorted(kept)).toEqual(sorted(named));
  });

  // A run that passed has nothing to investigate. The condition is what makes
  // an upload a diagnostic rather than a souvenir: it has to survive the step
  // before it failing, and a cancelled run has nothing to say.
  test.each(publishing)("$name uploads even after the step before it failed", ({ uploads }) => {
    for (const step of uploads) expect(record(step)["if"]).toBe("${{ !cancelled() }}");
  });
});
