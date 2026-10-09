import { createHash } from "node:crypto";

export const COUNTS = [
  "reactCommits",
  "mutationRecords",
  "requests",
  "bodyBytes",
  "scriptBytes",
] as const satisfies readonly (keyof PerCount<unknown>)[];

export type Count = (typeof COUNTS)[number];

/** The counts every phase has, whatever ran in it. */
type Always = keyof Steady<unknown>;

/** One value for each of the four counts every phase has. */
interface Steady<Value> {
  readonly mutationRecords: Value;
  readonly requests: Value;
  readonly bodyBytes: Value;
  readonly scriptBytes: Value;
}

/** One value per count: the four every phase has, and React's commits where there are any. */
interface PerCount<Value> extends Steady<Value> {
  /**
   * Present exactly when the phase ran in a document holding a React renderer:
   * the one current when it began, the one current when it ended, or one that
   * attached a renderer while it ran. Absent, never zero, otherwise.
   */
  readonly reactCommits?: Value;
}

/**
 * One phase's counts, which is also the shape of the `count-budget` attachment
 * each budgeted test carries, by phase.
 */
export type Counts = PerCount<number>;

/** The four counts every phase has, each made by `make`. */
export function always<Value>(make: (count: Always) => Value): Steady<Value> {
  return {
    mutationRecords: make("mutationRecords"),
    requests: make("requests"),
    bodyBytes: make("bodyBytes"),
    scriptBytes: make("scriptBytes"),
  };
}

/** What a test measured: its phases in the order it marked them. */
export type Measured = ReadonlyMap<string, Counts>;

/** A ceiling raised by hand: the ceiling the command last accepted, the new ceiling, and why. */
export interface Raised {
  readonly ceiling: number;
  readonly was: number;
  readonly reason: string;
}

export type Ceiling = number | Raised;

/** One phase's ceilings: a ceiling per count it measures. */
export type Ceilings = PerCount<Ceiling>;

export type Phases = ReadonlyMap<string, Ceilings>;

export interface Entry {
  readonly browser: string;
  readonly phases: Phases;
  readonly seal: string;
}

/** Where a test's ceilings are, for the messages that send a person there. */
export interface Where {
  readonly key: string;
  readonly spec: string;
  readonly ceilings: string;
}

/** The variable that turns a run into the command. */
export const MODE = "COUNT_BUDGET";

export const command = (where: Where): string => `${MODE}=write bunx playwright test ${where.spec}`;

/**
 * A JSON object out of a ceilings file, before anything is known about its keys.
 * Every lookup into one goes through `Object.hasOwn`, because a phase or a test
 * may be called `constructor` or `__proto__`.
 */
// oxlint-disable-next-line typescript/no-restricted-types, anti-slop/no-unsafe-dictionary-type -- the one boundary alias this module reads through: what a person wrote in a ceilings file
export type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJson(value: unknown, where: string): Json {
  if (!isJson(value)) throw new Error(`${where} is not a JSON object`);
  return value;
}

/** A ceilings file's text, read as the object it has to be. */
export function fileIn(text: string, path: string): Json {
  return asJson(JSON.parse(text), path);
}

export function isRaised(ceiling: Ceiling): ceiling is Raised {
  return typeof ceiling === "object";
}

export function ceilingOf(ceiling: Ceiling): number {
  return isRaised(ceiling) ? ceiling.ceiling : ceiling;
}

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const DIGEST = 8;

function digest(phase: string, count: Count, accepted: number): string {
  return createHash("sha256")
    .update(`${phase}\u0000${count}\u0000${accepted}`)
    .digest("hex")
    .slice(0, DIGEST);
}

/** A phase's ceilings that are there, in the order `COUNTS` lists them. */
function present(ceilings: Ceilings): [Count, Ceiling][] {
  return COUNTS.flatMap((count): [Count, Ceiling][] => {
    const ceiling = ceilings[count];
    return ceiling === undefined ? [] : [[count, ceiling]];
  });
}

/** Every count of an entry, in the one order its seal lists them. */
function slots(phases: Phases): [string, Count, Ceiling][] {
  return [...phases]
    .flatMap(([phase, ceilings]) =>
      present(ceilings).map(([count, ceiling]): [string, Count, Ceiling] => [
        phase,
        count,
        ceiling,
      ]),
    )
    .toSorted(([a, x], [b, y]) => byCodePoint(`${a}\u0000${x}`, `${b}\u0000${y}`));
}

/**
 * The seal: per count, a digest of the ceiling the command accepted for it. A
 * plain number is accepted as written, and a raise once the command has kept it.
 */
function sealOf(phases: Phases): string {
  return slots(phases)
    .map(([phase, count, ceiling]) => digest(phase, count, ceilingOf(ceiling)))
    .join("");
}

const slotKey = (phase: string, count: Count): string => `${phase}\u0000${count}`;

/**
 * The raises a person made since the command last wrote the entry: those whose
 * `was` is the number the seal accepted. `undefined` when any number was changed
 * in place, which is an edit the seal exists to catch.
 */
function freshRaises(entry: Entry): ReadonlySet<string> | undefined {
  const each = slots(entry.phases);
  if (entry.seal.length !== each.length * DIGEST) return undefined;
  const fresh = new Set<string>();
  for (const [index, [phase, count, ceiling]] of each.entries()) {
    const held = entry.seal.slice(index * DIGEST, (index + 1) * DIGEST);
    if (held === digest(phase, count, ceilingOf(ceiling))) continue;
    if (!isRaised(ceiling) || held !== digest(phase, count, ceiling.was)) return undefined;
    fresh.add(slotKey(phase, count));
  }
  return fresh;
}

function isCount(name: string): name is Count {
  return COUNTS.some((count) => count === name);
}

export function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function ceilingAt(value: unknown, where: string): Ceiling {
  if (isWhole(value)) return value;
  if (typeof value === "number") {
    throw new Error(`${where} is ${value}, and a ceiling is a whole number of zero or more`);
  }
  const { ceiling, was, reason } = asJson(value, where);
  if (!isWhole(ceiling) || !isWhole(was)) {
    throw new Error(
      `${where} is neither a whole number nor a raised ceiling written as { "ceiling": <new>, "was": <the ceiling the command last accepted>, "reason": "<why>" }`,
    );
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(
      `${where} is raised from ${was} to ${ceiling} with no reason: say why the page does more in its "reason"`,
    );
  }
  if (ceiling <= was) {
    throw new Error(
      `${where} is written as raised, but its ceiling ${ceiling} is not above the ${was} the command accepted; a lower ceiling is the command's to write`,
    );
  }
  return { ceiling, was, reason };
}

/** One phase's ceilings, read from a file a person may have edited. */
function phaseAt(value: unknown, where: string): Ceilings {
  const written = asJson(value, where);
  for (const count of Object.keys(written)) {
    if (!isCount(count)) {
      throw new Error(`${where}.${count} is not a count; the counts are ${COUNTS.join(", ")}`);
    }
  }
  const ceilings = always((count) => {
    if (!Object.hasOwn(written, count)) {
      throw new Error(`${where} has no ${count}, which every phase measures`);
    }
    return ceilingAt(written[count], `${where}.${count}`);
  });
  return Object.hasOwn(written, "reactCommits")
    ? { ...ceilings, reactCommits: ceilingAt(written["reactCommits"], `${where}.reactCommits`) }
    : ceilings;
}

/** One test's entry, read from a file a person may have edited. */
export function entryAt(value: unknown, where: string): Entry {
  const written = asJson(value, where);
  const { browser, seal } = written;
  if (typeof browser !== "string") throw new Error(`${where}.browser is not a string`);
  if (typeof seal !== "string") throw new Error(`${where}.seal is not a string`);
  const phases = new Map<string, Ceilings>();
  for (const [phase, ceilings] of Object.entries(asJson(written["phases"], `${where}.phases`))) {
    phases.set(phase, phaseAt(ceilings, `${where}.phases.${phase}`));
  }
  return { browser, phases, seal };
}

/** An entry as the file holds it. */
export function entryJson(entry: Entry): Json {
  return {
    browser: entry.browser,
    phases: Object.fromEntries(
      [...entry.phases].map(([phase, ceilings]) => [phase, Object.fromEntries(present(ceilings))]),
    ),
    seal: entry.seal,
  };
}

/** A whole file with one test's entry set, its tests in code-point order. */
export function withEntry(file: Json, key: string, entry: Entry): Json {
  const others = Object.entries(file).filter(([held]) => held !== key);
  return Object.fromEntries(
    [...others, [key, entryJson(entry)] as const].toSorted(([a], [b]) => byCodePoint(a, b)),
  );
}

/** An entry whose every ceiling the command accepted, or raised since in the form, with the raises it has not kept yet. */
export interface Sealed {
  readonly kind: "sealed";
  readonly entry: Entry;
  readonly raises: ReadonlySet<string>;
}

/** An entry that differs from its seal other than by a fresh raise: edited by hand, and refused. */
export interface HandEdited {
  readonly kind: "hand edited";
}

/** A test's entry as the file holds it, judged against its seal; nothing when the file has none. */
export function entryIn(file: Json, key: string, where: string): Sealed | HandEdited | undefined {
  if (!Object.hasOwn(file, key)) return undefined;
  const entry = entryAt(file[key], where);
  const raises = freshRaises(entry);
  return raises === undefined ? { kind: "hand edited" } : { kind: "sealed", entry, raises };
}

/** One way the entry the command would write differs from the one stored. */
export type Change =
  | { readonly kind: "new" }
  | { readonly kind: "browser"; readonly from: string; readonly to: string }
  | { readonly kind: "phase added"; readonly phase: string }
  | { readonly kind: "phase dropped"; readonly phase: string }
  | {
      readonly kind: "count added";
      readonly phase: string;
      readonly count: "reactCommits";
      readonly measured: number;
    }
  | {
      readonly kind: "count dropped";
      readonly phase: string;
      readonly count: "reactCommits";
      readonly ceiling: Ceiling;
    }
  | {
      readonly kind: "lowered";
      readonly phase: string;
      readonly count: Count;
      readonly measured: number;
      readonly ceiling: Ceiling;
    }
  | {
      readonly kind: "above";
      readonly phase: string;
      readonly count: Count;
      readonly measured: number;
      readonly ceiling: Ceiling;
    }
  | {
      readonly kind: "raise kept";
      readonly phase: string;
      readonly count: Count;
      readonly ceiling: Raised;
    };

/** A measured count against its ceiling: the lower of the two, and a change wherever they differ. */
function against(
  phase: string,
  count: Count,
  measured: number,
  ceiling: Ceiling,
  changes: Change[],
): Ceiling {
  if (measured < ceilingOf(ceiling)) {
    changes.push({ kind: "lowered", phase, count, measured, ceiling });
    return measured;
  }
  if (measured > ceilingOf(ceiling))
    changes.push({ kind: "above", phase, count, measured, ceiling });
  return ceiling;
}

function lowerPhase(
  phase: string,
  counts: Counts,
  stored: Ceilings,
): { next: Ceilings; changes: Change[] } {
  const changes: Change[] = [];
  const measured = counts.reactCommits;
  const ceiling = stored.reactCommits;
  let reactCommits: Ceiling | undefined = undefined;
  if (measured === undefined) {
    if (ceiling !== undefined)
      changes.push({ kind: "count dropped", phase, count: "reactCommits", ceiling });
  } else if (ceiling === undefined) {
    reactCommits = measured;
    changes.push({ kind: "count added", phase, count: "reactCommits", measured });
  } else {
    reactCommits = against(phase, "reactCommits", measured, ceiling, changes);
  }
  const next = always((count) => against(phase, count, counts[count], stored[count], changes));
  return { next: reactCommits === undefined ? next : { ...next, reactCommits }, changes };
}

/**
 * The one rule: what the command writes for a test, and every way that differs
 * from what is stored. Every ceiling becomes the lower of itself and the
 * measure; a count with no ceiling is written as measured; one no longer
 * measured is dropped; none is raised, so a count above its ceiling keeps the
 * ceiling. A check fails exactly when this lists a change.
 */
export function lowered(
  stored: Sealed | undefined,
  measured: Measured,
  browser: string,
): { entry: Entry; changes: Change[] } {
  const phases = new Map<string, Ceilings>(measured);
  if (stored === undefined) {
    return { entry: { browser, phases, seal: sealOf(phases) }, changes: [{ kind: "new" }] };
  }
  const { entry, raises } = stored;
  const changes: Change[] = [];
  if (entry.browser !== browser)
    changes.push({ kind: "browser", from: entry.browser, to: browser });
  for (const phase of entry.phases.keys()) {
    if (!measured.has(phase)) changes.push({ kind: "phase dropped", phase });
  }
  for (const [phase, counts] of measured) {
    const held = entry.phases.get(phase);
    if (held === undefined) {
      changes.push({ kind: "phase added", phase });
      continue;
    }
    const lower = lowerPhase(phase, counts, held);
    phases.set(phase, lower.next);
    changes.push(...lower.changes);
  }
  for (const [phase, count, ceiling] of slots(phases)) {
    if (isRaised(ceiling) && raises.has(slotKey(phase, count))) {
      changes.push({ kind: "raise kept", phase, count, ceiling });
    }
  }
  return { entry: { browser, phases, seal: sealOf(phases) }, changes };
}

function raiseOf(
  phase: string,
  count: Count,
  measured: number,
  ceiling: Ceiling,
  where: Where,
): string {
  const raise = isRaised(ceiling)
    ? `{ "ceiling": ${measured}, "was": ${ceiling.ceiling}, "reason": "<why the page does more>" } once the command has kept the raise it holds, or set this raise's "ceiling" to ${measured} before then`
    : `{ "ceiling": ${measured}, "was": ${ceiling}, "reason": "<why the page does more>" }`;
  return `«${phase}» ${count}: measured ${measured}, ceiling ${ceilingOf(ceiling)}. The page does more of this work than its ceiling allows: find the change that added it. If the extra work is meant, raise the ceiling by hand in ${where.ceilings} to ${raise}, then run ${command(where)} so the command keeps it.`;
}

/** What a person reads about one change. */
export function described(change: Change, where: Where): string {
  const run = `run ${command(where)} and commit ${where.ceilings}`;
  let said: string;
  switch (change.kind) {
    case "new":
      said = `no ceilings for this test in ${where.ceilings}: ${run}.`;
      break;
    case "browser":
      said = `the ceilings were measured on ${change.from}, and this run is ${change.to}. A count is only comparable on the browser build it was measured on. The command records this browser and lowers what dropped, and a count that rose keeps its ceiling and fails until it is raised by hand with a reason: ${run}.`;
      break;
    case "phase added":
      said = `«${change.phase}» has no ceilings: ${run}.`;
      break;
    case "phase dropped":
      said = `«${change.phase}» has ceilings, and this test no longer marks a phase of that name: ${run} to drop them.`;
      break;
    case "count added":
      said = `«${change.phase}» ${change.count}: measured ${change.measured}, and there is no ceiling for it: ${run}.`;
      break;
    case "count dropped":
      said = `«${change.phase}» ${change.count}: the ceiling is ${ceilingOf(change.ceiling)}, and no React renderer ran in this phase, so there is no count to hold to it: ${run} to drop it.`;
      break;
    case "lowered":
      said = `«${change.phase}» ${change.count}: measured ${change.measured}, ceiling ${ceilingOf(change.ceiling)}. The page does less than its ceiling, so the ceiling comes down to match: ${run}.`;
      break;
    case "above":
      said = raiseOf(change.phase, change.count, change.measured, change.ceiling, where);
      break;
    case "raise kept":
      said = `«${change.phase}» ${change.count} was raised by hand to ${change.ceiling.ceiling}, and the command has not kept the raise yet: ${run}, which seals it, so a later raise is a new edit of its own.`;
      break;
  }
  return said;
}
