/**
 * What serving HTTP costs a live repo that owns a database: a test proving its
 * operations are timed, written with request timing's conformance kit
 * (docs/exports/request-timing.md). Its own module beside `live.ts` the way
 * `browser-suite.ts` is, and called from the contract rather than from
 * `checkLive`, because its waiver is graded in every lifecycle: on a `dev` repo
 * it waives nothing, and that is a problem too.
 */
import type { Manifest, Problem } from "../_lib/gate.ts";
import { record, repoFiles } from "../_lib/gate.ts";
import { ownsDatabase, SHIPPED_FIELDS } from "./live.ts";

/**
 * The frameworks request timing has an entry connector for. Read from what a
 * manifest ships, so a library that takes one as a peer, or tests its
 * connectors against one as a devDependency, serves nothing.
 */
const SERVES_HTTP = ["elysia", "next", "@tanstack/react-start"] as const;

const KIT = "@gokayo43/dev-config/request-timing/conformance";

/** The input that says the operations are timed some other way, and how. */
const TIMED_OTHERWISE = "operations-timed-otherwise";

/**
 * The unit lane's files, where the kit runs against the booted server. A
 * `*.spec.ts` is a Playwright spec in this house, and the kit is a `bun test`
 * import.
 */
const TESTS = ["*.test.ts", "*.test.tsx"] as const;

/** The first manifest that ships one of the frameworks, with the name it ships. */
function servesHttp(all: readonly Manifest[]): { file: string; name: string } | undefined {
  for (const { file, value } of all) {
    for (const field of SHIPPED_FIELDS) {
      const name = SERVES_HTTP.find((each) => record(value[field])[each] !== undefined);
      if (name !== undefined) return { file, name };
    }
  }
  return undefined;
}

/** What a test file's imports came to: whether one is the kit, or that it would not parse. */
type Imports = "kit" | "other" | "unparsed";

/**
 * Whether a test file imports the kit, asked of Bun's own parser rather than
 * of the file's bytes: a specifier in a comment or a string is no import, and
 * a type-only import is erased and runs nothing. A file that will not parse is
 * reported back, since what it imports is then unknown rather than "nothing".
 */
async function importsOf(root: string, file: string): Promise<Imports> {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const text = await Bun.file(`${root}/${file}`).text();
  try {
    const { imports } = new Bun.Transpiler({ loader }).scan(text);
    return imports.some(({ path }) => path === KIT) ? "kit" : "other";
  } catch {
    return "unparsed";
  }
}

/** The test files that import the kit, and the ones that would not parse. */
async function conformanceTests(root: string): Promise<{ kit: string[]; unparsed: string[] }> {
  const files = await repoFiles(root, TESTS);
  const read = await Promise.all(
    files.map(async (file) => ({ file, imports: await importsOf(root, file) })),
  );
  const where = (wanted: Imports): string[] =>
    read.filter(({ imports }) => imports === wanted).map(({ file }) => file);
  return { kit: where("kit"), unparsed: where("unparsed") };
}

/**
 * The rule, and its waiver in every state. Owed by a live repo that owns a
 * database and ships one of the frameworks; met by a test importing the kit;
 * waived by a reason in `operations-timed-otherwise`, which is refused once it
 * waives nothing: on a repo that does not owe the rule, or beside a
 * conformance test that already meets it.
 */
export async function checkRequestTiming(
  root: string,
  all: readonly Manifest[],
  live: boolean,
  timedOtherwise: string,
): Promise<Problem[]> {
  const serving = servesHttp(all);
  const owned = live && serving !== undefined ? await ownsDatabase(root, all) : undefined;
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

  const { kit, unparsed } = await conformanceTests(root);
  const [met] = kit;
  if (met !== undefined) {
    return waived
      ? [
          {
            file: met,
            message: `${TIMED_OTHERWISE} says this repo's operations are timed some other way — "${timedOtherwise}" — and ${met} runs the conformance kit anyway. Take the input out of the call site, or the test out of the suite, so one answer says how the operations are timed.`,
          },
        ]
      : [];
  }
  if (waived) return [];

  const unread =
    unparsed.length === 0
      ? ""
      : ` ${unparsed.join(", ")} would not parse, so what it imports was not read.`;
  return [
    {
      file: serving.file,
      message: `a live repo that serves HTTP and owns a database proves its operations are timed — ${serving.file} ships ${serving.name} and ${owned}. Add a bun test that runs requestTimingConforms from ${KIT} against the booted server (docs/exports/request-timing.md, "Adopting it"), or, where the operations are timed some other way, say how in \`${TIMED_OTHERWISE}\` at the call site.${unread}`,
    },
  ];
}
