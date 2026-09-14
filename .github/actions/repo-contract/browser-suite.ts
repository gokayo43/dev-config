/**
 * What pages cost a live repo: the structural E2E suite testing.md asks of
 * every product that has any.
 *
 * Its own module beside `live.ts` for the reason `live.ts` is its own module
 * beside the contract — a repo carrying users owes this because it serves
 * pages, and it owes the data rules because it owns a schema, and those are two
 * subjects reached through one word. `live.ts` holds the word and calls in.
 *
 * How many flows the suite has is deliberately not graded. E2E is few and
 * structural, so a floor on flow count would be this gate asking for the
 * opposite of the rule it is derived from.
 */
import { DEPENDENCY_FIELDS, type Manifest, type Problem, record, repoFiles } from "../_lib/gate.ts";
import { CI_WORKFLOW } from "./ci-workflow.ts";
import { runsProgram } from "./package-scripts.ts";

/**
 * What shipping pages looks like in a manifest, which is STACK's two web picks:
 * TanStack Start and Vite React both ship `react-dom`, and a static site ships
 * `astro`. An Expo app ships `react-native` and an API or a worker ships
 * neither — exactly the set with no page for a browser to open, which is why
 * the list is these names and not a runtime prefix the way Sentry's is.
 *
 * Read from every dependency field, unlike the crash SDK. Sentry's question is
 * what a deployment *runs*, so a devDependency is a repo whose crashes nobody
 * hears; this question is what a browser *opens*, and the field says nothing
 * about that — a static site generator builds every page from
 * `devDependencies`, and a bundled SPA emits the same artifact whichever field
 * its framework was declared in.
 *
 * The named cost: an Expo app that lists `react-dom` for its web target owes
 * the suite from that line. That is the right answer whenever the target ships,
 * and the wrong one only for a repo carrying the dependency and serving nothing
 * from it — which no repo in this fleet does.
 */
const BROWSER_SURFACE = ["react-dom", "astro"] as const;

/** Whether anything in the workspace ships pages a browser opens. */
export function hasBrowserSurface(all: readonly Manifest[]): boolean {
  return all.some(({ value }) =>
    DEPENDENCY_FIELDS.some((field) =>
      BROWSER_SURFACE.some((name) => record(value[field])[name] !== undefined),
    ),
  );
}

const PLAYWRIGHT = "@playwright/test";

const PLAYWRIGHT_BIN = "playwright";

/**
 * The export a swept spec imports, which is the whole of what makes it swept.
 * Extensionless, and the built file behind it is the reason: Playwright's runner
 * is node, and node refuses to strip types from anything under `node_modules`.
 */
const SWEEP = "@gokayo43/dev-config/invariant-sweep";

/**
 * The specifier in the position that imports it, rather than anywhere in the
 * file's bytes: `from "…"`, `from '…'` and `import("…")`. A spec that names the
 * sweep in a note above the import it has not made yet, or in a string, is
 * precisely the spec this rule exists to fail — and reading the bytes passed
 * both.
 *
 * A pattern rather than a parse, because the alternative is a TypeScript parser
 * in a gate that runs before any install. What it still cannot tell apart is a
 * comment quoting an import statement verbatim, which is the one spelling left
 * that would fool it.
 */
const IMPORTED_FROM = new RegExp(
  String.raw`\b(?:from|import)\s*\(?\s*["']${SWEEP.replaceAll(".", String.raw`\.`)}["']`,
);

/**
 * Where a test runner is declared. Both fields, because a runner builds and
 * runs the suite rather than shipping — `devDependencies` is where it belongs
 * and `dependencies` is a repo that put it one line up, which is a packaging
 * opinion rather than a suite that does not exist.
 */
const RUNNER_FIELDS = ["devDependencies", "dependencies"] as const;

/**
 * A spec, by the suffix that tells an E2E spec from a unit test in this house.
 * `*.test.ts` is the unit lane — asking a unit test to import a browser fixture
 * would be this rule refusing every repo that has one. Git pathspecs, so the
 * listing is what a scaffolder has just written as well as what is committed,
 * and `*` crosses directories.
 */
const SPECS = ["*.spec.ts", "*.spec.tsx"] as const;

/** The lead-in every one of these three problems shares, since one missing suite is what they are all about. */
const A_SWEPT_SUITE = "a live repo with a browser surface carries a structural Playwright suite";

/**
 * The structural browser suite, in the three states that make it one: a runner
 * the repo has, specs written through the sweep, and a CI run. Three problems
 * rather than one, because each names a different file to fix — and all three
 * at once for a repo that has none of it, the way a missing data job reports
 * per job rather than as "the data jobs are missing".
 */
export async function checkBrowserSuite(
  root: string,
  all: readonly Manifest[],
  steps: readonly string[],
): Promise<Problem[]> {
  const problems: Problem[] = [];

  const declared = all.some(({ value }) =>
    RUNNER_FIELDS.some((field) => record(value[field])[PLAYWRIGHT] !== undefined),
  );
  if (!declared) {
    problems.push({
      file: "package.json",
      message: `${A_SWEPT_SUITE} — declare ${PLAYWRIGHT}, since a page nobody opens in CI is one that breaks in front of a user`,
    });
  }

  const specs = await repoFiles(root, SPECS);
  const swept = await Promise.all(
    specs.map(async (file) => IMPORTED_FROM.test(await Bun.file(`${root}/${file}`).text())),
  );
  if (!swept.includes(true)) {
    // The first spec, where there is one, and no file at all where there is
    // none: a repo with specs has somewhere to make the change, and a repo with
    // none is being told to write one.
    const [first] = specs;
    const message = `${A_SWEPT_SUITE} — write its specs with the invariant sweep's \`test\` (${SWEEP}), so every page a spec visits is checked for console errors, uncaught errors and overflow`;
    problems.push(first === undefined ? { message } : { file: first, message });
  }

  if (
    !steps.some((step) => runsProgram(step, { program: PLAYWRIGHT_BIN, argument: "test" }, all))
  ) {
    problems.push({
      file: CI_WORKFLOW,
      message: `${A_SWEPT_SUITE} — have ${CI_WORKFLOW} run it: add a job that runs \`${PLAYWRIGHT_BIN} test\` (directly or through a package script), since a suite CI never runs is one that ran the day it was written`,
    });
  }

  return problems;
}
