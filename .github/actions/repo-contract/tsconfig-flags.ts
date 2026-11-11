/**
 * What a tsconfig of the repo's own sets back: a check the shared base states,
 * written with the value that relaxes it, owes the reason above it that a lint
 * switch-off owes. Its own module because the subject is the base's
 * strictness, read from the base itself, and none of the rest of the contract
 * reads that file.
 */
import { withoutComments } from "../_lib/comments.ts";
import { type Problem, record, repoFiles } from "../_lib/gate.ts";
import { type Switches, unreasoned } from "./reasons.ts";

/**
 * The base as shipped at the ref the action runs from. A consumer moves its
 * action pins and its package pin in one pull request, so this is the base its
 * tsconfig extends, and a flag added to or dropped from it changes the check
 * with no second list to edit.
 */
const BASE = new URL("../../../tsconfig.base.json", import.meta.url);

/**
 * Booleans the base states that choose how a program is resolved or emitted
 * rather than what the checker refuses, so writing the other value weakens
 * nothing. Every other boolean the base states is a check, which is the safe
 * default for one added later.
 */
const NOT_CHECKS = new Set([
  "allowImportingTsExtensions",
  "esModuleInterop",
  "resolveJsonModule",
  "noEmit",
  "skipLibCheck",
]);

/**
 * What `strict` turns on (TypeScript's reference, under `strict`). The base
 * states `strict` alone, so a member written `false` is a check set back that
 * the base never names.
 */
const STRICT_FAMILY = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

/** Every check the base states, and the value that relaxes it. */
async function relaxingValues(): Promise<ReadonlyMap<string, boolean>> {
  const decoded: unknown = JSON.parse(withoutComments(await Bun.file(BASE).text()));
  const options = record(record(decoded)["compilerOptions"]);
  const relaxing = new Map<string, boolean>();
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "boolean" && !NOT_CHECKS.has(name)) relaxing.set(name, !value);
  }
  if (options["strict"] === true) for (const name of STRICT_FAMILY) relaxing.set(name, false);
  return relaxing;
}

/** A tsconfig by git's listing, at the root or below it; the pathspec's `*` also crosses `/`. */
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;

/**
 * Every tracked `tsconfig*.json`, each read on its own text: no `extends` chain
 * is followed, because what a file writes is what its reader reviews. No
 * exemption waives it, `config-lineage` included, which waives where a config
 * inherits from and never what it sets back.
 */
export async function checkWeakenedFlags(root: string): Promise<Problem[]> {
  const relaxing = await relaxingValues();
  const switches: Switches = new Map([
    [
      "compilerOptions",
      (text, at, name) => {
        const relaxed = relaxing.get(name);
        return relaxed !== undefined && text.startsWith(String(relaxed), at);
      },
    ],
  ]);
  const files = (await repoFiles(root, ["tsconfig*.json", "*/tsconfig*.json"])).filter((file) =>
    TSCONFIG.test(file),
  );
  const read = await Promise.all(
    files.map(async (file) => ({ file, text: await Bun.file(`${root}/${file}`).text() })),
  );
  return read.flatMap(({ file, text }) =>
    unreasoned(text, switches).map(({ name, line, crowded }) => {
      const written = `${name}: ${String(relaxing.get(name))}`;
      const why = crowded
        ? "shares its line with another entry — one weakened flag per line, its reason above"
        : "sets back a check the base turns on, with no reason — add the reason above the entry";
      return { file, line, message: `${file} ${written} ${why}` };
    }),
  );
}
