import { type Problem, parseEach, record, repoFiles } from "../_lib/gate.ts";

/** GitHub accepts both spellings for every one of these, so both are read. */
export const ACTION_FILES = [".github/actions/*/action.yml", ".github/actions/*/action.yaml"];
const OWN = [".github/workflows/*.yml", ".github/workflows/*.yaml", ...ACTION_FILES];

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
  // No need to skip the `uses` key below: its value is the string just taken,
  // and a string has no references inside it.
  return [
    ...(typeof uses === "string" ? [uses] : []),
    ...Object.values(node).flatMap(referencesIn),
  ];
}

/** `container: node:22` and `container: {image: node:22}` are one declaration, and a service is written the second way. */
function imageOf(node: unknown): string[] {
  if (typeof node === "string") return [node];
  const image = record(node)["image"];
  return typeof image === "string" ? [image] : [];
}

/**
 * Every image a job runs in or beside: its container, and each of its services.
 * Read off the jobs rather than walked the way `uses:` is — an image sits at
 * exactly this depth, and a walk would take an action input that happens to be
 * called `container` with it.
 */
export function imagesIn(document: unknown): string[] {
  return Object.values(record(record(document)["jobs"])).flatMap((job) => {
    const node = record(job);
    return [
      ...imageOf(node["container"]),
      ...Object.values(record(node["services"])).flatMap(imageOf),
    ];
  });
}

export interface Reference {
  readonly file: string;
  /** An image is held to the digest rule, an action to the commit rule. */
  readonly kind: "action" | "image";
  readonly value: string;
}

export function unpinned(references: readonly Reference[]): Problem[] {
  return references.flatMap(({ file, kind, value }) => {
    // A local action is this repo's own tree at this commit; there is no ref.
    if (kind === "action" && value.startsWith("./")) return [];
    // A job's image and a docker:// action are one kind of reference: a
    // registry name, where only the digest names a build for good.
    if (kind === "image" || value.startsWith("docker://")) {
      return DIGEST.test(value)
        ? []
        : [
            {
              file,
              message: `${value} is a mutable image tag — pin by @sha256: digest with the tag as a trailing comment`,
            },
          ];
    }
    return COMMIT.test(value)
      ? []
      : [
          {
            file,
            message: `${value} is not pinned — use a 40-character commit SHA with the tag as a trailing comment`,
          },
        ];
  });
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

  const references: Reference[] = documents.read.flatMap(({ file, value }) => [
    ...referencesIn(value).map((used) => ({ file, kind: "action" as const, value: used })),
    ...imagesIn(value).map((image) => ({ file, kind: "image" as const, value: image })),
  ]);

  return [...missing, ...documents.problems, ...unpinned(references)];
}
