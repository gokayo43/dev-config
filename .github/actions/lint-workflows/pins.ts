import { type Problem, parseEach, record, repoFiles } from "../_lib/gate.ts";

/** GitHub accepts both spellings for every one of these, so both are read. */
const OWN = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".github/actions/*/action.yml",
  ".github/actions/*/action.yaml",
];

const COMMIT = /@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * Every `uses:` in a parsed workflow or action, wherever it sits — a step's, a
 * job's `uses:` for a reusable workflow, a composite action's own steps. Read
 * off the parsed document rather than grepped: `-   uses:` with extra spacing,
 * a quoted value and a key nested somewhere the pattern did not anticipate are
 * all the same node to a parser and three separate holes in a regex.
 */
export function referencesIn(document: unknown): string[] {
  if (Array.isArray(document)) return document.flatMap(referencesIn);
  if (typeof document !== "object" || document === null) return [];

  const node = record(document);
  const uses = node["uses"];
  return [
    ...(typeof uses === "string" ? [uses] : []),
    ...Object.entries(node)
      .filter(([key]) => key !== "uses")
      .flatMap(([, value]) => referencesIn(value)),
  ];
}

export interface Reference {
  readonly file: string;
  readonly value: string;
}

export function unpinned(references: readonly Reference[]): Problem[] {
  return references
    .filter(({ value }) => {
      // A local action is this repo's own tree at this commit; there is no ref.
      if (value.startsWith("./")) return false;
      if (value.startsWith("docker://")) return !DIGEST.test(value);
      return !COMMIT.test(value);
    })
    .map(({ file, value }) => ({
      file,
      message: value.startsWith("docker://")
        ? `${value} is a mutable image tag — pin by @sha256: digest with the tag as a trailing comment`
        : `${value} is not pinned — use a 40-character commit SHA with the tag as a trailing comment`,
    }));
}

export async function pinGate(root: string, extraPaths: readonly string[]): Promise<Problem[]> {
  const own = await repoFiles(root, OWN);
  // An extra path that matches nothing is a problem in its own right: it is how
  // a renamed file quietly stops being checked.
  const extra = await Promise.all(extraPaths.map(async (path) => await repoFiles(root, [path])));
  const missing = extraPaths.flatMap((path, index) =>
    (extra[index] ?? []).length === 0
      ? [{ file: path, message: "extra-paths matched no file — check the path" }]
      : [],
  );

  const files = [...new Set([...own, ...extra.flat()])].toSorted((a, b) => a.localeCompare(b));
  const documents = await parseEach(root, files, (text) => Bun.YAML.parse(text), "YAML");

  return [
    ...missing,
    ...documents.problems,
    ...unpinned(
      documents.read.flatMap(({ file, value }) =>
        referencesIn(value).map((used) => ({ file, value: used })),
      ),
    ),
  ];
}
