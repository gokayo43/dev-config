import {
  type Allowlist,
  DEPENDENCY_FIELDS,
  isObject,
  kindOf,
  type Manifest,
  manifests,
  type Problem,
  record,
} from "../_lib/gate.ts";
import { aliasedPackage } from "../_lib/dependency-specs.ts";

/**
 * An entry as everything below it reads one: both lists present, every pattern
 * already a compiled expression, and a reason that says something. The file's
 * own spelling is `Written` below, and `denylistIn` is the only way from one to
 * the other.
 */
export interface DenylistEntry {
  /** Package names, matched exactly — which is what keeps `jest` from taking `jest-expo` with it. */
  readonly names: readonly string[];
  /** Expressions over the package name, for a whole scope. */
  readonly patterns: readonly RegExp[];
  readonly reason: string;
}

/**
 * The denylist's matching rule, exported because the suite holds the shipped
 * denylist to a property the walk below assumes — that no package name is
 * reached by two entries — and a test that reimplemented the rule would be
 * grading its own copy of it.
 */
export function denies(entry: DenylistEntry, name: string): boolean {
  return entry.names.includes(name) || entry.patterns.some((pattern) => pattern.test(name));
}

/** An entry as the file may spell it, which is the shape the checks below argue with. */
interface Written {
  readonly names?: unknown;
  readonly patterns?: unknown;
  readonly reason?: unknown;
}

/**
 * The fields an entry may carry, keyed by the type itself: a field added to
 * `Written` and not listed here is a compile error rather than a key the parse
 * silently refuses.
 */
const ENTRY_KEYS: Record<keyof Written, true> = { names: true, patterns: true, reason: true };

/** An array's items as what they are, since `isArray` narrows unknown to `any[]`. */
function itemsOf(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: readonly unknown[] = value;
  return items;
}

/** The packages an entry is about, for a diagnostic someone has to find it by. */
function entryLabel(entry: unknown, index: number): string {
  const subjects = (isObject(entry) ? [entry["names"], entry["patterns"]] : [])
    .flatMap((value) => itemsOf(value) ?? [])
    .filter((value) => typeof value === "string");
  return subjects.length > 0
    ? `entry ${index} (${subjects.join(", ")})`
    : `entry ${index} (${JSON.stringify(entry)})`;
}

/** A list of non-empty strings, or nothing when it is anything else. */
function stringsOf(value: unknown): string[] | undefined {
  const items = itemsOf(value);
  if (items === undefined) return undefined;
  const strings: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || item === "") return undefined;
    strings.push(item);
  }
  return strings;
}

/**
 * One entry as the shape every rule below reads, or what is wrong with it —
 * phrased to follow the entry's label. Built rather than asserted: the check
 * and the value come from the same read, so there is no point where an entry
 * has been validated and something else is passed on.
 *
 * The patterns are compiled here for the same reason. A pattern that is not an
 * expression is a fault in this file, and left to the walk it surfaces as a
 * SyntaxError from inside a loop over somebody's dependencies — attributed to
 * no entry, and only on the repos that declare enough to reach it.
 */
function entryIn(fields: Record<string, unknown>): DenylistEntry | string {
  const unknown = Object.keys(fields).filter((key) => !(key in ENTRY_KEYS));
  if (unknown.length > 0) {
    return `carries ${unknown.join(", ")}, which no rule here reads — a denylist entry is names, patterns and reason`;
  }

  const reason = fields["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    return "has no reason — the pick a package lost to is the whole diagnostic, and an entry that cannot say it is an entry nobody can act on";
  }

  const names = fields["names"] === undefined ? [] : stringsOf(fields["names"]);
  const written = fields["patterns"] === undefined ? [] : stringsOf(fields["patterns"]);
  if (names === undefined || written === undefined) {
    return "declares names or patterns as something other than a list of non-empty strings";
  }
  if (names.length + written.length === 0) {
    return "denies nothing — an entry names packages, patterns, or both";
  }

  const patterns: RegExp[] = [];
  for (const pattern of written) {
    try {
      patterns.push(new RegExp(pattern));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `declares ${pattern}, which is not an expression: ${detail}`;
    }
  }
  return { names, patterns, reason };
}

/**
 * The shipped denylist, refused outright rather than read as far as it parses.
 *
 * `reason` is the diagnostic, and every rule downstream treats having one as
 * the fact that the package is denied — so an entry whose key was misspelt
 * used to match its packages, carry no pick, and be read as no answer at all:
 * a rule silently disarmed, which also shadowed any later entry that would
 * have caught the same package. Reading the file into `DenylistEntry` here is
 * what makes that state unrepresentable further down, and an unknown key is
 * refused rather than ignored because a misspelt key is precisely how a
 * required one goes missing.
 *
 * It throws rather than reporting: this file ships beside the gate, so a
 * malformed one is not a repo's problem to fix, and there is nothing the gate
 * can honestly say about a tree while holding it. Every fault at once, because
 * a file worth refusing is worth fixing in one pass.
 */
export function denylistIn(value: unknown, source: string): readonly DenylistEntry[] {
  if (!isObject(value)) {
    throw new Error(`${source} is not a denylist: the top level is ${kindOf(value)}`);
  }
  const listed = itemsOf(value["entries"]);
  if (listed === undefined) {
    throw new Error(
      `${source} declares entries as ${kindOf(value["entries"])}, and a denylist is a list of them`,
    );
  }

  const read = listed.map((entry, index) => ({
    label: entryLabel(entry, index),
    result: isObject(entry) ? entryIn(entry) : `is ${kindOf(entry)}, not an object`,
  }));
  const faults = read.flatMap(({ label, result }) =>
    typeof result === "string" ? [`${label} ${result}`] : [],
  );
  if (faults.length > 0) throw new Error(`${source} is malformed: ${faults.join("; ")}`);

  return read.flatMap(({ result }) => (typeof result === "string" ? [] : [result]));
}

/** A dependency a manifest declares, and the denylist's answer for it if it has one. */
interface Declaration {
  readonly file: string;
  readonly field: string;
  /** The manifest key — how the repo spells it, and the line a reader has to find. */
  readonly key: string;
  /** The package this actually installs: what an `npm:` spec aliases, or the key itself. */
  readonly installs: string;
  /** The pick the installed package lost to, or nothing where the denylist is silent. */
  readonly reason: string | undefined;
}

/** The same, once it is known to be one the denylist answers for. */
interface Denied extends Declaration {
  readonly reason: string;
}

/**
 * Every dependency the tree declares, each carrying whatever the denylist says
 * about it. One walk: the two verdicts below are about the same packages read
 * two ways, and a second walk is how they come to disagree about what a repo
 * declares.
 *
 * What is graded is what the declaration installs, which is not always its key:
 * `"db": "npm:prisma@6"` installs prisma and says so nowhere in the key, and a
 * key-only reading is a spelling the whole denylist gets past. The key is not
 * itself a package — `"prisma": "npm:drizzle-orm@0.44.7"` installs the house
 * pick under an unfortunate local name, and refusing it would be refusing a
 * repo for what it calls a thing.
 *
 * The first denying entry wins. Two entries reaching one package would be one
 * package with two house picks — the denylist disagreeing with itself rather
 * than a repo with two problems to fix — and `no package is denied twice` in
 * tests/stack-gate.test.ts holds the shipped denylist to that.
 */
function declarationsIn(
  entries: readonly DenylistEntry[],
  read: readonly Manifest[],
): Declaration[] {
  return read.flatMap(({ file, value }) =>
    DEPENDENCY_FIELDS.flatMap((field) => {
      const declared = record(value[field]);
      return Object.keys(declared).map((key) => {
        const installs = aliasedPackage(declared[key]) ?? key;
        return {
          file,
          field,
          key,
          installs,
          reason: entries.find((entry) => denies(entry, installs))?.reason,
        };
      });
    }),
  );
}

/** Both spellings a waiver may use for one declaration: the key, and what it installs. */
function spellingsOf({ key, installs }: Declaration): readonly string[] {
  return key === installs ? [key] : [key, installs];
}

/**
 * `STACK.md` with an exit code, plus the one way past it: the package named in
 * `stack-allowlist`, with the reason beside it — docs/gates/stack-gate.md is
 * where the hatch is written down, including why it is an input rather than a
 * file in the repo.
 *
 * Both verdicts are read off that one walk. A denied package no waiver names is
 * refused; a waiver naming no denied package stands for nobody, and which of
 * the two ways that happened is the difference between an entry to drop and a
 * name to fix, so the diagnostic says which. What a waiver may name is either
 * spelling of a declaration, because the reader who wrote it was looking at one
 * of them and both identify the same line.
 *
 * The allowlist arrives whole rather than as its entries, so that enforcing the
 * reason on each of them is not something a caller can typecheck without.
 */
export async function stackGate(
  root: string,
  denylistPath: string | URL,
  allowlist: Allowlist,
): Promise<Problem[]> {
  const entries = denylistIn(await Bun.file(denylistPath).json(), String(denylistPath));

  const waived = new Set(allowlist.entries);
  const found = await manifests(root);

  const declarations = declarationsIn(entries, found.read);
  const denied = declarations.filter((entry): entry is Denied => entry.reason !== undefined);
  const deniedNames = new Set(denied.flatMap(spellingsOf));
  const declaredNames = new Set(declarations.flatMap(spellingsOf));

  // Named by the key, since that is the line to edit, and by what it installs
  // when the two differ, since that is the package the reason is about.
  const refusals = denied
    .filter((entry) => !spellingsOf(entry).some((name) => waived.has(name)))
    .map(({ file, field, key, installs, reason }) => ({
      file,
      message: `${field}.${key}${key === installs ? "" : `, an npm: alias for ${installs},`} is not the house pick — ${reason}; a deviation someone agreed to goes in stack-allowlist with its reason`,
    }));

  // A waiver naming no denied package stands for nobody, and there are two ways
  // to get there. The package is still declared and the denylist has stopped
  // answering for it — the pick it deviated from is gone — or nothing here
  // declares it at all, which is a dependency dropped or a name never spelled
  // the way the entry spells it. Sending the first case name-hunting is how a
  // retired denylist entry costs every consumer an afternoon.
  //
  // An entry already refused for saying nothing about why is not asked this
  // second question: its author is going back to that line regardless, and one
  // mistake earns one diagnostic.
  const fossils = [...waived]
    .filter((subject) => !deniedNames.has(subject) && !allowlist.unreasoned.has(subject))
    .map((subject) => ({
      message: declaredNames.has(subject)
        ? `stack-allowlist waives ${subject}, which the denylist no longer answers for — the pick it was written against is gone, so drop the entry`
        : `stack-allowlist waives ${subject}, which nothing here declares — drop the entry, or fix the name to match the dependency it was written for`,
    }));

  // A fossil is only visible against a complete reading of the tree, and a
  // manifest that will not parse leaves the walk short of whatever that file
  // declared — so every waiver written for it would be reported dead, burying
  // the problem that has to be fixed first under findings that are artefacts of
  // it. The refusals stand either way: a tree with one unreadable manifest is
  // not a tree with no rules.
  const whole = found.problems.length === 0;

  return [...allowlist.problems, ...found.problems, ...refusals, ...(whole ? fossils : [])];
}
