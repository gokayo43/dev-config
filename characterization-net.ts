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
}

/** What a re-baseline answers with: a report, and the one thing only it can say. */
export interface Rebaseline extends Report {
  /**
   * The goldens this run wrote. Empty when nothing changed, which is the whole
   * point — the diff of a re-baseline is the behaviour delta and nothing else.
   * It is here rather than on `Report` because an assert never writes, and a
   * field that is structurally empty in half its uses is one nobody reads.
   */
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

/** What an operation does with one case, once its golden has a usable name and a fresh capture. */
type Act = (name: string, text: string) => Promise<string[]>;

/** What a pass over the cases found. */
interface Walked {
  readonly ran: string[];
  readonly failures: string[];
}

/**
 * One pass over the cases, shared by both operations — which is the whole of
 * what "one build path" means here. The capture, the normaliser and the
 * serialiser are called from exactly this line, so a re-baseline recording
 * something the assert would never compare is not a bug to be refused; it has
 * no way to happen.
 *
 * The name is checked **before** the capture. A capture is a request against the
 * app, and a case whose golden could never be found is not one to send a request
 * for.
 */
async function walk<Case, Body>(
  net: Net<Case, Body>,
  chosen: readonly Case[],
  act: Act,
): Promise<Walked> {
  const ran: string[] = [];
  const failures: string[] = [];
  for (const subject of chosen) {
    const name = net.nameOf(subject);
    const wrong = unusable(name);
    if (wrong !== undefined) {
      failures.push(wrong);
      continue;
    }
    ran.push(name);
    failures.push(...(await act(name, serialize(net.normalize(await net.capture(subject))))));
  }
  return { ran, failures };
}

/**
 * The golden files no case claims. A case that was deleted and a fixture that
 * was not, which will sit there being green forever.
 *
 * Said in one place because it is one rule: both operations ask it, and two
 * copies of the sentence are two sentences to keep saying the same thing.
 */
async function reconcile(dir: string, ran: readonly string[]): Promise<string[]> {
  const claimed = new Set(ran.map((name) => `${name}${SUFFIX}`));
  return (await goldensIn(dir))
    .filter((file) => !claimed.has(file))
    .map(
      (file) =>
        `${file} is a golden no case claims — delete it, or restore the case it belongs to; an unclaimed fixture is green forever and grades nothing`,
    );
}

/**
 * Runs the net against its committed goldens.
 *
 * Unsharded, it also reconciles. A shard cannot — it sees a fraction of the
 * cases and would call the rest orphans — so a sharded driver unions the
 * shards' `ran` and reconciles from there.
 */
export async function assertNet<Case, Body>(net: Net<Case, Body>, shard?: Shard): Promise<Report> {
  const { ran, failures } = await walk(net, shardOf(net.cases, shard), async (name, text) => {
    const committed = await goldenAt(`${net.dir}/${name}${SUFFIX}`);
    if (committed === undefined) {
      return [
        `${name} has no golden — re-baseline to record what it does today, and review that file as the behaviour it pins`,
      ];
    }
    const expected = reNormalized(net.normalize, committed);
    if (expected === undefined) {
      return [
        `${name}'s golden is not a capture — it has to be an object with a numeric \`status\` and a \`body\`; re-baseline it rather than hand-editing it`,
      ];
    }
    return expected === text
      ? []
      : [`${name} does not match its golden.\nexpected:\n${expected}\nactual:\n${text}`];
  });

  const unclaimed = shard === undefined ? await reconcile(net.dir, ran) : [];
  const whole = [...failures, ...unclaimed];
  return { summary: summarise(ran.length, whole.length, shard), ran, failures: whole };
}

/**
 * What the summary says a re-baseline did, so the run leaves the blessing
 * somewhere and not only in whoever typed it. A re-baseline is reviewed as the
 * behaviour delta it writes, and the sentence that justified writing it belongs
 * beside the count of what was written.
 */
function whatItWrote(wrote: readonly string[], blessing: string): string {
  if (wrote.length === 0) return "no golden changed";
  if (blessing === "") return `wrote ${wrote.length} new, none of which needed blessing`;
  return `wrote ${wrote.length}, blessed: ${JSON.stringify(blessing)}`;
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
  blessing = "",
): Promise<Rebaseline> {
  const blessed = blessing.trim();
  const wrote: string[] = [];
  await mkdir(net.dir, { recursive: true });

  const { ran, failures } = await walk(net, net.cases, async (name, text) => {
    const path = `${net.dir}/${name}${SUFFIX}`;
    const committed = await goldenAt(path);
    if (committed === text) return [];
    if (committed !== undefined && blessed === "") {
      return [
        `${name} would change, and this run blessed nothing — re-run naming what makes the new output correct, since overwriting a golden is blessing whatever it used to pin`,
      ];
    }
    await writeFile(path, text, "utf8");
    wrote.push(name);
    return [];
  });

  const whole = [...failures, ...(await reconcile(net.dir, ran))];
  return {
    summary: `${summarise(ran.length, whole.length, undefined)} — ${whatItWrote(wrote, blessed)}`,
    ran,
    failures: whole,
    wrote,
  };
}
