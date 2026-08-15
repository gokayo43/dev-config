import { DEPENDENCY_FIELDS, kindOf, type Manifest, type Problem, record } from "./gate.ts";

/**
 * The version grammar: how a dependency spec is read, and what each field a
 * manifest may declare one in demands of it. Two opposite rules live here and
 * that is the point of the file — what this repo installs must resolve to one
 * tree, and what it declares a consumer may bring must refuse something — so
 * the vocabulary they argue over sits in one place rather than beside the
 * checks about files.
 *
 * It sits beside `gate.ts` rather than inside a gate because two of them read
 * it: the repo contract grades every spec through `checkPins` and reads a major
 * off one through `isExactVersion`, and the stack denylist asks `aliasedPackage`
 * which package a manifest actually installs.
 */

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * `npm:` aliases another package, so the alias's own spec is the one that has
 * to be exact. Both halves are part of the one match rather than sliced off
 * afterwards, and the version is optional because `npm:bar` names none: a
 * slice-then-recurse reading of that spelling recurses on its own input
 * forever, and a match that required a version would not see the package
 * either — which is a package installed under a name no rule reading keys can
 * see.
 */
const NPM_ALIAS = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/;

/**
 * The package an `npm:` spec installs, which is not the key it is installed
 * under. Every rule that grades the package rather than the version reads it
 * through here: the alias is the one form in which a manifest names a package
 * somewhere other than in its key, and a check that only reads keys grades a
 * tree the repo does not have.
 */
export function aliasedPackage(spec: unknown): string | undefined {
  return typeof spec === "string" ? NPM_ALIAS.exec(spec)?.[1] : undefined;
}

/** The protocols whose tree is whatever they point at, which is one tree by construction. */
const RESOLVED_PROTOCOL = /^(workspace|file|link|catalog|portal):/;

/** A git dependency resolves to one tree only when its ref is a commit. */
const GIT_PROTOCOL = /^(github|gitlab|bitbucket|git|git\+[a-z]+):/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Whether the spec says where the package comes from rather than which versions
 * of it will do. `isExact` grades these on whether the source they name is one
 * tree; the peer rule below only has to know that they are not ranges, so that
 * nothing tries to read `github:owner/repo` as one.
 */
function namesSource(spec: string): boolean {
  return RESOLVED_PROTOCOL.test(spec) || GIT_PROTOCOL.test(spec) || spec.startsWith("npm:");
}

/**
 * An allowlist, not a blocklist. `18`, `next` and `1.x` float exactly as much
 * as `^1.2.3` does, and the ways npm spells "whatever is newest" are
 * open-ended — so a spec has to prove it resolves to one thing rather than fail
 * to match a list of the spellings someone thought of.
 *
 * The protocols below are exact by construction: a workspace member is whatever
 * the workspace holds, a path names one tree, a git dependency names one when it
 * carries a ref, and `npm:` is an alias whose own spec is checked.
 */
function isExact(spec: string): boolean {
  if (EXACT_SEMVER.test(spec)) return true;
  if (RESOLVED_PROTOCOL.test(spec)) return true;
  const alias = NPM_ALIAS.exec(spec);
  if (alias !== null) return EXACT_SEMVER.test(alias[2] ?? "");
  // `#main` moves, a tag can be repointed, and `#semver:^1.0.0` is a range
  // wearing a fragment. Only a commit names one tree for good.
  if (GIT_PROTOCOL.test(spec)) return COMMIT.test(spec.slice(spec.indexOf("#") + 1));
  return false;
}

/**
 * What is wrong with a spec for the field it sits in, phrased to follow
 * `${field}.${name}` — or nothing, when it is fine.
 */
type Rule = (spec: unknown) => string | undefined;

/** What this repo installs names one tree, so that a lockfile refresh cannot change it. */
const installed: Rule = (spec) =>
  typeof spec === "string" && isExact(spec)
    ? undefined
    : `is declared as '${String(spec)}' — a dependency names one exact version, or a protocol that resolves to one tree`;

/**
 * Two versions no constraining range holds both of: the floor of the release
 * line, and a major nobody reaches. `^0` and `0.x` hold the first and not the
 * second, `>=19` the second and not the first — each of them constrains, which
 * is what a peer range is for.
 */
const FLOOR = "0.0.0";
const UNREACHABLE_MAJOR = "999999.0.0";

/**
 * Whether the resolver would take any version at all. Asked of Bun's own semver
 * rather than matched against a list of the spellings, because the spellings are
 * not a list: `*` and `x`, `>=0`, `>=v0` — a leading `v` is legal grammar —
 * `>0.0.0-0`, and every union built out of them, since an `||` takes whatever
 * any one of its operands takes. The engine that will read this range at install
 * time is the one asked about it.
 *
 * Two probes rather than a proof. A range admitting everything under some absurd
 * ceiling would pass; nobody writes one, and the alternative is a semver solver
 * of our own.
 */
function acceptsEveryVersion(range: string): boolean {
  return Bun.semver.satisfies(FLOOR, range) && Bun.semver.satisfies(UNREACHABLE_MAJOR, range);
}

/**
 * The wildcard spellings a tag could be mistaken for — not what decides a
 * refusal, which is the question above, but which of the two diagnostics is the
 * true one. `x` is a range that takes anything; `latest` is a name that is not a
 * range; both are a word to a pattern over letters, and each leaves the author
 * something different to fix.
 *
 * Only `x` and `X`, because this is read behind `TAG`, which a spelling with a
 * `*` in it never matches.
 */
const WILDCARD = /^[xX](\.[xX]){0,2}$/;

/** A tag is a name npm repoints; a version is what a range is written from. */
const TAG = /^[a-zA-Z][\w.-]*$/;

/**
 * Whether any `||` operand is a dist tag. Per operand, because one operand npm
 * cannot read is a range npm cannot read, and a digit anywhere else in the
 * string would otherwise answer for the whole of it.
 *
 * This is the only thing that catches a union carrying a tag. `latest` alone is
 * a string Bun's semver cannot parse, which it reads as matching everything, so
 * the question below would refuse it — with the wrong diagnostic. But
 * `latest || 1` answers false to both probes, so without this the whole spec
 * would pass in silence: no diagnostic at all, for a range npm cannot resolve.
 */
function namesATag(range: string): boolean {
  return range.split("||").some((operand) => {
    const part = operand.trim();
    return TAG.test(part) && !WILDCARD.test(part) && !/\d/.test(part);
  });
}

/**
 * A peer range, graded on whether it refuses anything. peerDependencies is the
 * one field where a range is the point — it states what a consumer may bring,
 * not what this repo installs — so the rule is the pin check's inverted, and so
 * is its polarity: a denylist here, where `isExact` is an allowlist. Neither
 * set is enumerable, though, which is why the question goes to a resolver
 * rather than to a pattern.
 *
 * A range that names no version at all is refused beside those for a different
 * reason, which the diagnostic says: it is a dist tag, npm repoints those, and
 * what it points at today is not in this manifest. That catches the tags people
 * type — `latest`, `next` — and not the ones carrying a digit; the gate page
 * says why nothing here can do better.
 *
 * `bun add <pkg>` for a package the manifest already lists as a peer writes one
 * of these rather than adding a devDependency (bun 1.3.11), and which one
 * depends on the peer. With `peerDependenciesMeta.optional` the range is
 * blanked — that is the case this catches, and the empty range has its own
 * diagnostic because it is the one nobody chose. Without the optional meta the
 * range is overwritten with the exact version bun installed, `>=3` becoming
 * `3.0.1`, and nothing here can catch that: an exact peer range is legitimate
 * when someone means it, and one manifest cannot tell the two apart.
 */
const peerRange: Rule = (spec) => {
  if (typeof spec !== "string") {
    return `is declared as ${JSON.stringify(spec)} — a peer range is a string naming the versions a consumer may bring, and this is ${kindOf(spec)}`;
  }
  const range = spec.trim();
  if (range === "") {
    return "is empty — write the versions a consumer may bring, e.g. '>=1.2.3'. 'bun add' empties the range of an optional peer it is asked to add rather than adding a devDependency, so a manifest with peers writes them by hand";
  }
  // A protocol says where the package comes from rather than which versions do,
  // and the semver below would read it as a string it cannot parse — which is to
  // say, as a range that takes anything.
  //
  // Only when it is the whole spec. A source is one place and cannot be one
  // alternative among versions, so a `||` here means the string is a union
  // whatever its first operand looks like — and read whole, `workspace:* ||
  // latest` passed while `latest || workspace:*` was refused, which is one
  // verdict for two spellings of the same thing. Unions fall through to the
  // grading below, which reads every operand.
  if (!range.includes("||") && namesSource(range)) return undefined;
  if (namesATag(range)) {
    return `is declared as '${spec}' — a peer range names versions, and a dist tag names whatever it points at today; write the range it stands for`;
  }
  if (acceptsEveryVersion(range)) {
    return `is declared as '${spec}' — a peer range that accepts every version says what declaring no peer says; name the versions this package works against`;
  }
  return undefined;
};

/**
 * One rule per field a manifest may declare a package in, keyed by the list
 * itself: a field added to `DEPENDENCY_FIELDS` and not graded here is a
 * compile error rather than a silent hole.
 */
const PIN_RULES = {
  dependencies: installed,
  devDependencies: installed,
  optionalDependencies: installed,
  peerDependencies: peerRange,
} satisfies Record<(typeof DEPENDENCY_FIELDS)[number], Rule>;

export function checkPins(all: readonly Manifest[]): Problem[] {
  return all.flatMap(({ file, value }) =>
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.entries(record(value[field])).flatMap(([name, spec]) => {
        const fault = PIN_RULES[field](spec);
        return fault === undefined ? [] : [{ file, message: `${field}.${name} ${fault}` }];
      }),
    ),
  );
}

/**
 * Whether the spec is a plain exact version — the question the contract's
 * typescript floor asks before reading a major off it. Exported as a predicate
 * rather than as the pattern, so that what a caller can do with it is ask.
 */
export function isExactVersion(spec: string): boolean {
  return EXACT_SEMVER.test(spec);
}
