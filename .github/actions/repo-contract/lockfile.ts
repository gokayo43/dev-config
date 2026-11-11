/**
 * `bun.lock`, which is the one file in a repo that says what an install puts
 * in `node_modules`: a manifest says what was asked for, and a peer range the
 * package declares is recorded beside the version that resolved. Its own module
 * because the rest of the contract reads what a repo declares, and this reads
 * what it resolved, with no install, since an action runs without one.
 */
import { type ConfigObject, isList, type Problem, readConfig, record } from "../_lib/gate.ts";

const LOCK = "bun.lock";

const OXLINT = "oxlint";

const TSGOLINT = "oxlint-tsgolint";

/** A resolved package: the version it resolved to and the metadata the lock records with it. */
interface Resolved {
  readonly version: string;
  readonly peers: ConfigObject;
}

/**
 * Every entry of `packages` that resolved `name`, read off the entry's own
 * `name@version` rather than its key, since a key names where in the tree an
 * entry sits (`some-dep/oxlint` for a nested copy) and the identity is what
 * resolved there.
 */
function resolvedAs(packages: ConfigObject, name: string): Resolved[] {
  return Object.values(packages).flatMap((entry) => {
    if (!isList(entry)) return [];
    const [identity, , meta] = entry;
    if (typeof identity !== "string" || !identity.startsWith(`${name}@`)) return [];
    return [
      {
        version: identity.slice(name.length + 1),
        peers: record(record(meta)["peerDependencies"]),
      },
    ];
  });
}

/**
 * The `oxlint-tsgolint` the lock resolved sits inside the range every resolved
 * `oxlint` declares for it. oxlint names it an optional peer, so bun installs a
 * pair outside that range without a word, and the type-aware rules then run on
 * a binary the linter was not released against. Nothing to hold where the lock
 * is absent, resolves no `oxlint-tsgolint` (the manifest check owns a missing
 * one), or holds an `oxlint` that declares no range for it.
 */
export async function checkTypeAwarePair(root: string): Promise<Problem[]> {
  if (!(await Bun.file(`${root}/${LOCK}`).exists())) return [];
  const lock = await readConfig(root, LOCK);
  if (lock.contents === undefined) return [...lock.problems];
  const packages = record(lock.contents["packages"]);
  const tsgolints = resolvedAs(packages, TSGOLINT);
  return resolvedAs(packages, OXLINT).flatMap(({ version: oxlint, peers }) => {
    const range = peers[TSGOLINT];
    if (typeof range !== "string") return [];
    return tsgolints
      .filter(({ version }) => !Bun.semver.satisfies(version, range))
      .map(({ version }) => ({
        file: LOCK,
        message: `${LOCK} resolves ${TSGOLINT} ${version} beside ${OXLINT} ${oxlint}, which declares ${range} for it — move ${TSGOLINT} to a version inside ${range}`,
      }));
  });
}
