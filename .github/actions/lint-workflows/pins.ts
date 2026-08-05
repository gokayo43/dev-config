import { type Problem, record } from "../_lib/gate.ts";

/** GitHub accepts both spellings for every one of these, so both are read. */
const WORKFLOWS = ".github/workflows/*.{yml,yaml}";
const ACTIONS = ".github/actions/**/action.{yml,yaml}";

const COMMIT = /@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

export interface Reference {
  readonly file: string;
  readonly value: string;
}

/**
 * Every `uses:` in a parsed workflow or action, wherever it sits — a step's, a
 * job's `uses:` for a reusable workflow, a composite action's own steps. Read
 * off the parsed document rather than grepped: `-   uses:` with extra spacing,
 * a quoted value and a key nested somewhere the pattern did not anticipate are
 * all the same node to a parser and three separate holes in a regex.
 */
export function referencesIn(file: string, document: unknown): Reference[] {
  if (Array.isArray(document)) return document.flatMap((entry) => referencesIn(file, entry));
  if (typeof document !== "object" || document === null) return [];

  const node = record(document);
  const uses = node["uses"];
  return [
    ...(typeof uses === "string" ? [{ file, value: uses }] : []),
    ...Object.entries(node)
      .filter(([key]) => key !== "uses")
      .flatMap(([, value]) => referencesIn(file, value)),
  ];
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

/**
 * The files to read. An extra path that matches nothing is a problem in its own
 * right: it is how a renamed file quietly stops being checked.
 */
async function pinnedFiles(
  root: string,
  extraPaths: readonly string[],
): Promise<{ files: string[]; problems: Problem[] }> {
  // `dot: true` is load-bearing: without it Bun.Glob skips every path under a
  // dot-directory, and the gate would scan nothing at all under .github while
  // reporting clean.
  const own = [WORKFLOWS, ACTIONS].flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, dot: true }),
  ]);

  const extra: string[] = [];
  const problems: Problem[] = [];
  for (const path of extraPaths) {
    const matched = [...new Bun.Glob(path).scanSync({ cwd: root, onlyFiles: true, dot: true })];
    if (matched.length === 0) {
      problems.push({ file: path, message: `extra-paths matched no file — check the path` });
      continue;
    }
    extra.push(...matched);
  }

  return { files: [...new Set([...own, ...extra])].sort(), problems };
}

export async function pinGate(root: string, extraPaths: readonly string[]): Promise<Problem[]> {
  const { files, problems } = await pinnedFiles(root, extraPaths);
  const references = await Promise.all(
    files.map(async (file) =>
      referencesIn(file, Bun.YAML.parse(await Bun.file(`${root}/${file}`).text())),
    ),
  );
  return [...problems, ...unpinned(references.flat())];
}
