/**
 * What serving HTTP costs a live repo that owns a database: a test proving its
 * operations are timed, written with request timing's conformance kit
 * (docs/exports/request-timing.md), and where the repo runs Effect, a test
 * running the kit's check of that Effect. Its own module beside `live.ts` the way
 * `browser-suite.ts` is, and called from the contract rather than from
 * `checkLive`, because its waiver is graded in every lifecycle: on a `dev` repo
 * it waives nothing, and that is a problem too.
 */
import type { Manifest, Problem } from "../_lib/gate.ts";
import { record, repoFiles } from "../_lib/gate.ts";
import { SHIPPED_FIELDS } from "./live.ts";

/**
 * The frameworks request timing has an entry connector for. Read from what a
 * manifest ships, so a library that takes one as a peer, or tests its
 * connectors against one as a devDependency, serves nothing.
 */
const SERVES_HTTP = ["elysia", "next", "@tanstack/react-start"] as const;

const KIT = "@gokayo43/dev-config/request-timing/conformance";

/**
 * The kit's check of the app's own Effect, owed beside the kit where a
 * manifest ships `effect`: request timing counts an Effect program's waits
 * right only on an Effect that resumes each fiber in its own async context.
 */
const EFFECT_CHECK = "@gokayo43/dev-config/request-timing/conformance/effect";

/** The input that says the operations are not timed by request timing, and why. */
const TIMED_OTHERWISE = "operations-timed-otherwise";

/**
 * The unit lane's files, where the kit runs against the booted server. A
 * `*.spec.ts` is a Playwright spec in this house, and the kit is a `bun test`
 * import.
 */
const TESTS = ["*.test.ts", "*.test.tsx"] as const;

/**
 * The first manifest that ships one of `names` itself, not through another
 * package, with the name it ships.
 */
function shipping(
  all: readonly Manifest[],
  names: readonly string[],
): { file: string; name: string } | undefined {
  for (const { file, value } of all) {
    for (const field of SHIPPED_FIELDS) {
      const name = names.find((each) => record(value[field])[each] !== undefined);
      if (name !== undefined) return { file, name };
    }
  }
  return undefined;
}

/**
 * What a test file's imports came to: which of the kit and its Effect check
 * it imports, or that it would not parse.
 */
type Imports = readonly string[] | "unparsed";

/**
 * Which of the kit and its Effect check a test file imports, asked of Bun's
 * own parser rather than of the file's bytes: a specifier in a comment or a
 * string is no import, and a type-only import is erased and runs nothing. `scanImports` and never
 * `scan`, which evaluates the Bun macros a file imports, running code from the
 * tree under review inside the gate (probed, bun 1.4.4). It reads paths, not
 * bindings, so it cannot tell `requestTimingConforms` from the route-tree
 * check. A file that will not parse is reported back, since what it imports is
 * then unknown rather than "nothing".
 */
async function importsOf(root: string, file: string): Promise<Imports> {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const text = await Bun.file(`${root}/${file}`).text();
  try {
    const imports = new Bun.Transpiler({ loader }).scanImports(text);
    return [KIT, EFFECT_CHECK].filter((wanted) => imports.some(({ path }) => path === wanted));
  } catch {
    return "unparsed";
  }
}

/**
 * The test files that import the kit, the ones that import its Effect check,
 * and the ones that would not parse.
 */
async function conformanceTests(
  root: string,
): Promise<{ kit: string[]; effect: string[]; unparsed: string[] }> {
  const files = await repoFiles(root, TESTS);
  const read = await Promise.all(
    files.map(async (file) => ({ file, imports: await importsOf(root, file) })),
  );
  const importing = (wanted: string): string[] =>
    read
      .filter(({ imports }) => imports !== "unparsed" && imports.includes(wanted))
      .map(({ file }) => file);
  return {
    kit: importing(KIT),
    effect: importing(EFFECT_CHECK),
    unparsed: read.filter(({ imports }) => imports === "unparsed").map(({ file }) => file),
  };
}

/**
 * The rule, and its waiver in every state. Owed by a live repo that owns a
 * database and ships one of the frameworks; met by a test importing the kit,
 * and where a manifest ships `effect`, a test importing the kit's Effect
 * check too; waived, both halves at once, by a reason in
 * `operations-timed-otherwise` saying how the operations are timed instead,
 * or that the repo serves nothing a connector covers. The waiver is refused
 * once it waives nothing: on a repo that does not owe the rule, or beside a
 * test that imports the kit or its Effect check.
 * @param owned The database witness `ownsDatabase` found, asked only of a live repo.
 */
export async function checkRequestTiming(
  root: string,
  all: readonly Manifest[],
  live: boolean,
  owned: string | undefined,
  timedOtherwise: string,
): Promise<Problem[]> {
  const serving = shipping(all, SERVES_HTTP);
  const waived = timedOtherwise !== "";

  if (serving === undefined || owned === undefined) {
    if (!waived) return [];
    const why = !live
      ? "this repo is not live"
      : serving === undefined
        ? `no manifest ships ${SERVES_HTTP.join(", ")}`
        : "this repo owns no database";
    return [
      {
        message: `${TIMED_OTHERWISE} is waiving nothing — request timing is owed by a live repo that serves HTTP and owns a database, and ${why}. Take it out of the call site.`,
      },
    ];
  }

  const { kit, effect, unparsed } = await conformanceTests(root);
  const [met] = kit;
  if (waived) {
    const running = met ?? effect[0];
    return running === undefined
      ? []
      : [
          {
            file: running,
            message: `${TIMED_OTHERWISE} says this repo's operations are not timed by request timing — "${timedOtherwise}" — and ${running} runs ${running === met ? "the conformance kit" : "the kit's Effect check"} anyway. Take the input out of the call site, or the test out of the suite, so one answer says how the operations are timed.`,
          },
        ];
  }

  const unread =
    unparsed.length === 0
      ? ""
      : ` ${unparsed.join(", ")} would not parse, so what it imports was not read.`;
  const problems: Problem[] = [];
  if (met === undefined) {
    problems.push({
      file: serving.file,
      message: `a live repo that serves HTTP and owns a database proves its operations are timed — ${serving.file} ships ${serving.name} and ${owned}. Add a bun test that runs requestTimingConforms from ${KIT} against the booted server (docs/exports/request-timing.md, "Adopting it"), or say in \`${TIMED_OTHERWISE}\` at the call site how the operations are timed some other way, or that the repo serves nothing a connector covers.${unread}`,
    });
  }
  const effectShipped = shipping(all, ["effect"]);
  if (effectShipped !== undefined && effect.length === 0) {
    // The waiver is offered only where the kit's test is missing too: beside
    // it, the waiver is refused.
    const otherwise =
      met === undefined
        ? `, or say in \`${TIMED_OTHERWISE}\` at the call site how the operations are timed some other way`
        : "";
    problems.push({
      file: effectShipped.file,
      message: `a repo whose operations request timing times, and that runs Effect, proves its Effect counts each wait in its own operation — ${effectShipped.file} ships effect, and request timing is right inside an Effect program only on effect 4.0.1 or later on a host with node:async_hooks. Add a bun test that runs requestTimingEffectConforms from ${EFFECT_CHECK} with the app's effect (docs/exports/request-timing.md, "Adopting it")${otherwise}.${unread}`,
    });
  }
  return problems;
}
