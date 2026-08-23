/**
 * The harness a golden — characterization — net is built on, and the rules that
 * keep one honest once it is large enough that nobody reads all of it.
 *
 * The testing canon already asks for golden oracles built from real captured
 * payloads. This is the layer under that: at a few thousand fixtures a net stops
 * failing by being wrong and starts failing by being *believed* — a re-baseline
 * that blessed a regression, a shard that crashed and read as green, a golden
 * compared against bytes that no longer resemble what the normaliser emits. Each
 * rule below closes one of those, and the ones that are structural are closed by
 * the shape of `Net` rather than by a check:
 *
 * 1. **One build path for asserting and for re-baselining.** There is one
 *    `capture` and one `normalize`, and both operations call them. The classic
 *    bug — goldens updated through a different request-build than they are
 *    compared with — is not something this refuses; it is something it cannot
 *    express.
 * 2. **The committed golden is re-normalised before comparison**, never trusted
 *    to still be byte-identical to what today's normaliser would emit. A net
 *    that compares raw bytes turns every normaliser change into a thousand-file
 *    re-baseline, which is the diff nobody reads.
 * 3. **A golden is written only when it changed.** A re-baseline's diff is then
 *    exactly the behaviour delta, which is the only thing that makes reviewing
 *    golden diffs like code possible.
 * 4. **Changing an existing golden needs a blessing.** Creating one does not: a
 *    new case has no behaviour to regress. Overwriting one does, and a
 *    re-baseline run that cannot say what it is blessing is a re-baseline nobody
 *    decided to do.
 * 5. **Status is part of the golden**, in the type, from day 0. A sidecar
 *    mechanism for it is accretive, and an accretive mechanism covers whatever
 *    fraction of the net somebody got round to.
 * 6. **Sharding is a pure function** of the case list and the shard count, so a
 *    run at any parallelism — including one shard — covers exactly the same
 *    cases in the same order.
 * 7. **Orphans fail.** A golden file no case claims is a case that was deleted
 *    and a fixture that was not, and it will sit there being green forever.
 * 8. **Every run answers with a summary line.** A shard that died wrote no
 *    report at all, and a driver that asserts the summary of each shard is what
 *    stops that reading as a pass. The driver is the repo's, because how it
 *    shards is; docs/exports/characterization-net.md carries the shape, along
 *    with the outbound-golden rule this module deliberately does not implement.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

/**
 * One case's outcome. Status and body together and neither optional: a net that
 * can hold a body without the status it came with is a net that will, for most
 * of its cases, for as long as it exists.
 */
export interface Capture<Body> {
  readonly status: number;
  readonly body: Body;
}

/**
 * A net, as the repo that owns it declares it. Both type parameters are
 * inferred from the object literal, and the body being one of them is what
 * keeps the narrowing out of every consumer's normaliser: a repo writes the
 * shape its app returns, and this module owns the one place a file off disk is
 * read back into it.
 */
export interface Net<Case, Body> {
  /** Every case, in a stable order. The shard split is a pure function of this list. */
  readonly cases: readonly Case[];
  /** The golden's file name for a case, without a suffix. Unique, stable, and no path separators. */
  readonly nameOf: (subject: Case) => string;
  /** Runs the case against the app. The one build path — both operations go through it. */
  readonly capture: (subject: Case) => Promise<Capture<Body>>;
  /** Drops what varies between runs. Applied to a fresh capture *and* to every committed golden. */
  readonly normalize: (captured: Capture<Body>) => Capture<Body>;
  /** Where the goldens live. Created on a re-baseline; read on an assert. */
  readonly dir: string;
}

/** One slice of a run, as a driver names it: `index` of `count`, zero-based. */
export interface Shard {
  readonly index: number;
  readonly count: number;
}

/** What a run answers with. */
export interface Report {
  /**
   * One line, always. Its absence is how a crashed shard reads as green, so
   * every driver asserts it and none of them has to construct it.
   */
  readonly summary: string;
  /** The golden names this run covered — what a sharded driver unions to reconcile. */
  readonly ran: string[];
  /** Everything wrong, as the sentences a failing test prints. */
  readonly failures: string[];
  /** The golden files this run wrote. Always empty for an assert. */
  readonly wrote: string[];
}

const SUFFIX = ".json";

/**
 * A capture as its golden file reads. The one serialiser: what is written is
 * what is compared, so nothing about the golden's shape is decided twice.
 *
 * Key order is left as the normaliser emitted it rather than sorted, because
 * re-normalising the committed file already makes order agree — both sides of
 * every comparison come out of the same normaliser and the same
 * `JSON.stringify`, so there is no ordering for a canonicaliser to reconcile.
 */
function serialize<Body>(captured: Capture<Body>): string {
  return `${JSON.stringify({ status: captured.status, body: captured.body }, null, 2)}\n`;
}

/** What the golden at this path holds, or nothing where there is no file. */
async function goldenAt(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every golden file in the directory, or none where the directory is not there yet. */
async function goldensIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((entry) => entry.endsWith(SUFFIX));
  } catch {
    return [];
  }
}

/**
 * The committed golden as today's normaliser would emit it, or the reason it
 * cannot be read that way. Re-normalising is what stops a normaliser change
 * from reading as a thousand behaviour changes.
 */
function reNormalized<Body>(
  normalize: (captured: Capture<Body>) => Capture<Body>,
  text: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!("status" in parsed) || typeof parsed.status !== "number") return undefined;
  const status: number = parsed.status;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place a golden crosses back in. The file is what this module wrote out of a `Body`, and only the repo's own normaliser knows that shape, so nothing here could check it; the status beside it is checked, because a file whose status is not a number is not a capture at all. Keeping the assertion here is what keeps every consuming repo's normaliser free of one.
  const body = ("body" in parsed ? parsed.body : undefined) as Body;
  return serialize(normalize({ status, body }));
}

/** The slice of the run this shard owns: every case whose position is its own, in order. */
function shardOf<Case>(cases: readonly Case[], shard: Shard | undefined): readonly Case[] {
  if (shard === undefined) return cases;
  return cases.filter((_, position) => position % shard.count === shard.index);
}

/** One case, run through the build path both operations share. */
interface Fresh {
  readonly name: string;
  readonly text: string;
}

async function freshly<Case, Body>(net: Net<Case, Body>, subject: Case): Promise<Fresh> {
  return { name: net.nameOf(subject), text: serialize(net.normalize(await net.capture(subject))) };
}

function summarise(ran: number, failures: number, shard: Shard | undefined): string {
  const of = shard === undefined ? "" : ` (shard ${shard.index + 1} of ${shard.count})`;
  return `characterization net${of}: ${ran} cases, ${failures} failures`;
}

/**
 * A name that cannot be a file in one flat directory is a name whose golden the
 * reconciliation below can never find, so the net would grow a case nothing
 * grades and an orphan nobody can explain.
 */
function unusable(name: string): string | undefined {
  if (name === "") return "a case has an empty golden name";
  if (name.includes("/") || name.includes("\\")) {
    return `the golden name ${JSON.stringify(name)} has a path separator in it — goldens live in one flat directory, and a nested one is a file the orphan check can never account for`;
  }
  return undefined;
}

/**
 * Runs the net against its committed goldens.
 *
 * Unsharded, it also reconciles: a golden file no case claims is a failure. A
 * shard cannot — it sees a fraction of the cases and would call the rest
 * orphans — so a sharded driver unions the shards' `ran` and reconciles from
 * there.
 */
export async function assertNet<Case, Body>(net: Net<Case, Body>, shard?: Shard): Promise<Report> {
  const chosen = shardOf(net.cases, shard);
  const failures: string[] = [];
  const ran: string[] = [];

  for (const subject of chosen) {
    const { name, text } = await freshly(net, subject);
    const wrong = unusable(name);
    if (wrong !== undefined) {
      failures.push(wrong);
      continue;
    }
    ran.push(name);

    const committed = await goldenAt(`${net.dir}/${name}${SUFFIX}`);
    if (committed === undefined) {
      failures.push(
        `${name} has no golden — re-baseline to record what it does today, and review that file as the behaviour it pins`,
      );
      continue;
    }
    const expected = reNormalized(net.normalize, committed);
    if (expected === undefined) {
      failures.push(
        `${name}'s golden is not a capture — it has to be an object with a numeric \`status\` and a \`body\`; re-baseline it rather than hand-editing it`,
      );
      continue;
    }
    if (expected !== text) {
      failures.push(`${name} does not match its golden.\nexpected:\n${expected}\nactual:\n${text}`);
    }
  }

  if (shard === undefined) {
    const claimed = new Set(ran.map((name) => `${name}${SUFFIX}`));
    for (const file of await goldensIn(net.dir)) {
      if (claimed.has(file)) continue;
      failures.push(
        `${file} is a golden no case claims — delete it, or restore the case it belongs to; an unclaimed fixture is green forever and grades nothing`,
      );
    }
  }

  return { summary: summarise(ran.length, failures.length, shard), ran, failures, wrote: [] };
}

/**
 * Records what the net does today, through the same capture, the same
 * normaliser and the same serialiser the assert path uses.
 *
 * A golden that would not change is not written, so the diff of a re-baseline is
 * exactly the behaviour delta. A golden that *would* change is written only
 * under a blessing — a sentence naming what makes the change correct — because
 * overwriting a golden is blessing whatever it used to pin, and a run that
 * cannot say what it is blessing is one nobody decided to do. A golden that does
 * not exist yet is created without one: a new case has no behaviour to regress.
 */
export async function rebaselineNet<Case, Body>(
  net: Net<Case, Body>,
  blessing?: string,
): Promise<Report> {
  const failures: string[] = [];
  const ran: string[] = [];
  const wrote: string[] = [];
  const blessed = (blessing ?? "").trim() !== "";
  await mkdir(net.dir, { recursive: true });

  for (const subject of net.cases) {
    const { name, text } = await freshly(net, subject);
    const wrong = unusable(name);
    if (wrong !== undefined) {
      failures.push(wrong);
      continue;
    }
    ran.push(name);

    const path = `${net.dir}/${name}${SUFFIX}`;
    const committed = await goldenAt(path);
    if (committed === text) continue;
    if (committed !== undefined && !blessed) {
      failures.push(
        `${name} would change, and this run blessed nothing — re-run naming what makes the new output correct, since overwriting a golden is blessing whatever it used to pin`,
      );
      continue;
    }
    await writeFile(path, text, "utf8");
    wrote.push(name);
  }

  const claimed = new Set(ran.map((name) => `${name}${SUFFIX}`));
  for (const file of await goldensIn(net.dir)) {
    if (claimed.has(file)) continue;
    failures.push(
      `${file} is a golden no case claims — delete it, or restore the case it belongs to; an unclaimed fixture is green forever and grades nothing`,
    );
  }

  return { summary: summarise(ran.length, failures.length, undefined), ran, failures, wrote };
}
