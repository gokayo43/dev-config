/**
 * What a tsconfig of the repo's own sets back: a check the shared base states,
 * written with the value that relaxes it or with `null`, owes the reason above
 * it that a lint switch-off owes. Its own module because the subject is the
 * base's strictness, read from the base itself, and none of the rest of the
 * contract reads that file.
 */
import { fileURLToPath } from "node:url";

import { configObjects, type Problem, readConfig, record, repoFiles } from "../_lib/gate.ts";
import { type Setting, type Switches, unreasoned } from "./reasons.ts";

/**
 * The checkout the action runs from, which holds the base as shipped at the
 * ref the consumer pinned. A consumer moves its action pins and its package
 * pin in one pull request, so this is the base its tsconfig extends, and a
 * flag added to or dropped from it changes the check with no second list to
 * edit.
 */
const ACTION_CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));

const BASE = "tsconfig.base.json";

/**
 * Booleans the base states that choose how a program is resolved or emitted
 * rather than what the checker refuses, so writing another value weakens
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
 * the base never names. Written `null`, a member is left to `strict`, which
 * sets back nothing.
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

/** The checks the base states, and the checks it turns on through `strict`, each with the value that relaxes it. */
interface Checks {
  readonly stated: ReadonlyMap<string, boolean>;
  readonly family: ReadonlyMap<string, boolean>;
}

async function checksOfBase(): Promise<Checks> {
  const base = await readConfig(ACTION_CHECKOUT, BASE);
  if (base.contents === undefined) {
    throw new Error(`the shipped ${BASE} cannot be read: ${JSON.stringify(base.problems)}`);
  }
  const options = record(base.contents["compilerOptions"]);
  const stated = new Map<string, boolean>();
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "boolean" && !NOT_CHECKS.has(name)) stated.set(name, !value);
  }
  const family = new Map<string, boolean>(
    options["strict"] === true ? STRICT_FAMILY.map((name) => [name, false]) : [],
  );
  return { stated, family };
}

/**
 * `null` un-states what the base states and hands the check back to
 * TypeScript's default, whatever that is in the installed version, so it sets
 * back a stated check as surely as the relaxing value does.
 */
function weakens({ stated, family }: Checks, value: Setting, name: string): boolean {
  const relaxed = stated.get(name) ?? family.get(name);
  return (value === null && stated.has(name)) || (relaxed !== undefined && value === relaxed);
}

/** A tsconfig by git's listing, at the root or below it; the pathspec's `*` also crosses `/`. */
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;

/**
 * Every `tsconfig*.json` the gate lists (tracked, and untracked where git
 * would keep it), each read on its own text: no `extends` chain is followed,
 * because what a file writes is what its reader reviews. A file that will not
 * parse is named, and the root's is named by the lineage check, which reads
 * it too. No exemption waives the check, `config-lineage` included, which
 * waives where a config inherits from and never what it sets back.
 */
export async function checkWeakenedFlags(root: string): Promise<Problem[]> {
  const checks = await checksOfBase();
  const switches: Switches = new Map([
    ["compilerOptions", (value, name) => weakens(checks, value, name)],
  ]);
  const files = (await repoFiles(root, ["tsconfig*.json", "*/tsconfig*.json"])).filter((file) =>
    TSCONFIG.test(file),
  );
  const { read, problems } = await configObjects(root, files, "JSON with comments");
  return [
    ...problems.filter(({ file }) => file !== "tsconfig.json"),
    ...read.flatMap(({ file, text }) =>
      unreasoned(text, switches).map(({ name, value, line, crowded }) => {
        const why = crowded
          ? "shares its line with another entry — one weakened flag per line, its reason above"
          : "sets back a check the base turns on, with no reason — add the reason above the entry";
        return { file, line, message: `${name}: ${JSON.stringify(value)} ${why}` };
      }),
    ),
  ];
}
