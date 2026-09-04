import {
  type Allowlist,
  baseRevision,
  type Event,
  git,
  isList,
  kindOf,
  type Problem,
  readConfig,
  type Verdict,
} from "../_lib/gate.ts";
import { declaredIn } from "../_lib/lifecycle.ts";
import { EVERY_METHOD, type Route } from "../../../route-log.ts";
import { key, routeIn, waivedBy } from "./route-table.ts";

/**
 * The route compatibility floor: a repo carrying people does not quietly stop
 * serving a route it served at the base ref.
 *
 * What it holds the app to is a file the repo commits, because there is nothing
 * else honest to hold it to. The base ref's route table is not in the checkout:
 * nothing here boots the base ref's app, and deriving a route table from source
 * is the second source of truth `route-log.ts` exists to avoid. A committed
 * snapshot is the app's own answer as of a commit, and `git show` reads it at
 * any of them.
 *
 * It is a golden the app keeps honest. Every run compares the blob at HEAD with
 * the booted app's own table and refuses a difference, so the golden cannot rot
 * into a description of an app that no longer exists, and a route added or
 * dropped is a line in the pull request's diff. The gate is the generator — the
 * content it wants is printed above its annotations and uploaded with the
 * evidence — so there is no regeneration script to run against the wrong app, or
 * forget to run at all.
 *
 * The blob rather than the working tree, because the blob is what the *next*
 * run reads at the base ref: a stale committed copy under a correct working tree
 * is exactly the drift this floor exists to catch, and it is what a checkout
 * filter — `eol=crlf`, a smudge — would otherwise turn into a permanent red
 * nobody could clear.
 *
 * The comparison against the base ref is one method and one path per line, and
 * docs/gates/route-compat.md is honest about how little that is: a field dropped
 * from a response, a status that changed, a body the route stopped accepting are
 * all compatible to it.
 */

/** Where the snapshot lives, at the root of whatever project the action was pointed at. */
export const SNAPSHOT = "routes.snapshot.json";

const READS_THE_BASE_REF = "a live repo is held to the routes its snapshot carried at the base ref";

/** Code point order, one field at a time. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * By path, then by method — and by code point rather than by `localeCompare`,
 * which orders by whatever ICU data the runtime was built with. This decides
 * bytes a repo commits, so a snapshot regenerated on another machine has to come
 * out identical or the file is a diff nobody caused.
 */
function ordered(a: Route, b: Route): number {
  const path = compare(a.path, b.path);
  return path === 0 ? compare(a.method, b.method) : path;
}

/**
 * The route table as the file states it: one line per route, sorted, and the
 * method upper-cased — the spelling `key` compares by, so the file cannot say
 * `get /health` about a route every diagnostic here calls `GET /health`.
 */
function canonical(served: readonly Route[]): Route[] {
  const named = new Map<string, Route>();
  for (const route of served) {
    const name = key(route);
    if (!named.has(name)) named.set(name, { method: route.method.toUpperCase(), path: route.path });
  }
  return [...named.values()].toSorted(ordered);
}

/** Those routes as the file's bytes. */
export function snapshotOf(served: readonly Route[]): string {
  const rows = canonical(served).map(({ method, path }) => ({ method, path }));
  return `${JSON.stringify(rows, undefined, 2)}\n`;
}

/**
 * A snapshot as a commit carried it. Parsed at the boundary rather than
 * asserted through: it is a file a person edits, and one that will not read is
 * refused rather than taken for a repo that served nothing — which would pass
 * every route in the world as still served.
 */
function routesIn(text: string, source: string): Route[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${String(error)}`, { cause: error });
  }
  if (!isList(parsed)) {
    throw new Error(
      `${source} is not a route snapshot: the top level is ${kindOf(parsed)}, and a snapshot is a list of {"method","path"} pairs`,
    );
  }
  return parsed.map((route) => routeIn(route, source));
}

/** A tracked file as a commit holds it, or why this checkout could not say. */
type Blob =
  | { readonly text: string }
  /** The commit is readable and does not carry the path. An answer, not a failure. */
  | { readonly absent: true }
  /** git could not answer at all, which is a fact about the checkout rather than about the repo. */
  | { readonly broken: string };

/**
 * The blob, distinguishing "that commit had no such file" from "this checkout
 * could not read it". `git show` collapses the two into one non-zero exit, and
 * reading that as the first is how a floor passes by having been handed nothing:
 * a blobless clone (`--filter=blob:none`) whose promisor is unreachable has
 * every tree and no contents, and answers exactly that way.
 *
 * `ls-tree` is what separates them — it reads the tree, exits 0 either way, and
 * prints the path only when the commit carries it. `./` makes the pathspec
 * relative to the working directory, which is where a monorepo's project sits.
 */
async function blobAt(root: string, rev: string, path: string): Promise<Blob> {
  const listed = await git(root, ["ls-tree", "--name-only", "-z", rev, "--", `./${path}`]);
  if (!listed.ok) {
    return {
      broken: `could not read ${rev.slice(0, 7)}: \`git ls-tree\` failed in ${root} — ${READS_THE_BASE_REF}, and a checkout that cannot answer is refused rather than read as carrying nothing`,
    };
  }
  if (listed.stdout.split("\0").every((name) => name === "")) return { absent: true };

  const shown = await git(root, ["show", `${rev}:./${path}`]);
  if (!shown.ok) {
    return {
      broken: `${rev.slice(0, 7)} lists ${path} and this checkout cannot read its contents — the object is missing, which is what a partial clone looks like when its promisor is unreachable; fetch it with a full checkout`,
    };
  }
  return { text: shown.stdout };
}

/** What the floor is asked about: the app's own answer, and the checkout it is held against. */
export interface Compatibility {
  /** The project the action was pointed at — where the snapshot is, and where the manifest is. */
  readonly root: string;
  /** What the run knows about where it came from, which is all a base ref derives from. */
  readonly event: Event;
  /** Every route the booted app declared, out of the route log the ramp already fetched. */
  readonly served: readonly Route[];
  /** `route-retire`, whole: the reason on each entry is enforced by reporting `problems`. */
  readonly retire: Allowlist;
  /** Where to leave the content the snapshot must hold, so adopting it is a copy. */
  readonly evidence: string;
}

/** The base ref's snapshot, or why the routes in it are not being held. */
type Held =
  | { readonly at: string; readonly routes: readonly Route[] }
  /** Nothing is held, and that is the honest answer: the clause the note carries. */
  | { readonly unheld: string }
  /** Nothing is held and that is itself the failure. */
  | { readonly broken: string };

/**
 * Whether anyone is on the other end, read the way the repo contract reads it —
 * `_lib/lifecycle.ts` is the one derivation, so a repo cannot be live to one
 * gate and dev to another. A manifest that is not there or will not parse is
 * refused rather than read as `dev`: this job installed from it minutes ago, so
 * it is a working directory pointed somewhere wrong, and every rule below would
 * otherwise switch itself off.
 */
async function isLive(root: string): Promise<boolean> {
  const manifest = await readConfig(root, "package.json", "JSON");
  if (manifest.contents === undefined) {
    throw new Error(
      `the lifecycle field decides whether the routes the base ref served are held, and this project's package.json could not be read: ${manifest.problems.map(({ message }) => message).join("; ")}`,
    );
  }
  return declaredIn(manifest.contents).is === "live";
}

async function baseSnapshot(root: string, event: Event): Promise<Held> {
  const base = await baseRevision(root, event, READS_THE_BASE_REF);
  // A live repo that cannot say what it served before is not a repo that served
  // nothing. The database job checks out the whole history for the upgrade gate,
  // so reaching this is a broken run, and passing it would be the floor
  // switching itself off on the one lifecycle it exists for.
  if ("refused" in base) return { broken: base.refused };
  if (base.rev === undefined) {
    return { unheld: "there is no commit before this one to hold it to" };
  }

  const at = base.rev.slice(0, 7);
  const blob = await blobAt(root, base.rev, SNAPSHOT);
  if ("broken" in blob) return { broken: blob.broken };
  if ("absent" in blob) {
    return { unheld: `${at} carried no ${SNAPSHOT}, so this is the first commit that has one` };
  }
  return { at, routes: routesIn(blob.text, `the ${SNAPSHOT} at ${at}`) };
}

/** The snapshot as this commit carries it, against the one the app just declared. */
interface Committed {
  readonly problems: Problem[];
  /** The content the file must hold, printed only where the commit does not hold it. */
  readonly log?: string;
}

async function committed(root: string, content: string): Promise<Committed> {
  const blob = await blobAt(root, "HEAD", SNAPSHOT);
  if ("broken" in blob) return { problems: [{ message: blob.broken }] };
  if ("absent" in blob) {
    return {
      log: content,
      problems: [
        {
          message: `this commit carries no ${SNAPSHOT} — commit the route table printed above this step's annotations, which is also uploaded as ${SNAPSHOT} in the db-gate evidence artifact. It is what makes a route this app stops serving visible in a diff.`,
        },
      ],
    };
  }
  if (blob.text === content) return { problems: [] };
  return {
    log: content,
    problems: [
      {
        file: SNAPSHOT,
        message: `${SNAPSHOT} is not the route table this app serves — replace it with the content printed above this step's annotations, which is also uploaded as ${SNAPSHOT} in the db-gate evidence artifact, and commit it. What is compared is the committed file as git stores it, byte for byte, so it is the gate's to generate and nobody's to hand-edit.`,
      },
    ],
  };
}

/**
 * What the base ref served, still served. A route registered for every method
 * covers whatever the base ref served on that path: the app answers all of them.
 * The reverse is a removal — a base ref serving `ALL /events` and a branch
 * serving only its `GET` has stopped answering every other method — which is why
 * this asks about the branch's catch-alls and not the base ref's.
 */
function servesAll(served: readonly Route[]): (route: Route) => boolean {
  const routes = new Set(served.map(key));
  const anyMethod = new Set(
    served.filter(({ method }) => method.toUpperCase() === EVERY_METHOD).map(({ path }) => path),
  );
  return (route) => routes.has(key(route)) || anyMethod.has(route.path);
}

/**
 * An input nothing is going to read, refused rather than accepted in silence.
 * The entries name a comparison that is not happening on this repo, so every
 * question about them — is it a route, was it served, is it still — has no
 * answer, and answering "fine" is how a repo ends up carrying a hatch it thinks
 * is holding something.
 */
function unread(retire: Allowlist, unheld: string): Problem[] {
  if (retire.entries.length === 0) return [];
  return [
    {
      message: `route-retire is set and nothing reads it: ${unheld}. Drop the input, or declare the lifecycle this repo is actually at.`,
    },
  ];
}

export async function routeCompat({
  root,
  event,
  served,
  retire,
  evidence,
}: Compatibility): Promise<Verdict> {
  const routes = canonical(served);
  const content = snapshotOf(served);
  // Written whichever way the run goes: on a red run it is the file to copy, and
  // on a green one it is what this app declared, kept beside the ramp's own
  // evidence for the run after it.
  await Bun.write(evidence, content);

  const file = await committed(root, content);
  // The count the file holds rather than the table's length: a router naming one
  // route twice is one line and one route to every comparison here.
  const serving = `route compatibility: ${routes.length} routes served`;
  const base = (await isLive(root))
    ? await baseSnapshot(root, event)
    : { unheld: "the lifecycle field does not read live, so no route is held to the base ref" };

  const held = ((): { readonly note: string; readonly problems: Problem[] } => {
    // The refusal says everything a note would, so the note carries only what it
    // does not: what this app serves. gate.ts's `note` is for the line the
    // problems leave unsaid.
    if ("broken" in base) return { note: serving, problems: [{ message: base.broken }] };
    if ("unheld" in base) {
      return { note: `${serving}; ${base.unheld}`, problems: unread(retire, base.unheld) };
    }

    const carried = new Map(base.routes.map((route) => [key(route), route]));
    const hatch = waivedBy(retire, carried, servesAll(served), {
      malformed: (entry) =>
        `route-retire entry '${entry}' is not a route — write 'METHOD /path -- why', matching a line of the ${SNAPSHOT} at ${base.at}`,
      unknown: (entry) =>
        `route-retire names ${entry}, which ${base.at} did not serve — drop the entry, or fix the method and path to match the route it was written for`,
      // The reason written beside it says this route is gone deliberately. It is
      // still being served, so the reason is not true of this branch.
      satisfied: (entry) =>
        `route-retire retires ${entry}, which this app still serves — drop the entry and let the floor hold the route`,
    });

    const kept = carried.size - hatch.unmet.length - hatch.waived.size;
    return {
      note: `${serving}; of the ${carried.size} at ${base.at}, ${kept} still served and ${hatch.waived.size} retired`,
      problems: [
        ...retire.problems,
        ...hatch.unmet.map((name) => ({
          // The way out is the whole diagnostic: a reader of the red needs the
          // line to add, filled in for their route, not the name of an input to
          // go and look up.
          message: `${name} was served at ${base.at} and this app no longer serves it — a repo carrying people does not stop answering a route they already call. Serve it again, or, if it is gone on purpose, retire it by adding this line to route-retire: '${name} -- why it went, and where its callers went'`,
        })),
        ...hatch.problems,
      ],
    };
  })();

  return {
    note: held.note,
    ...(file.log === undefined ? {} : { log: file.log }),
    problems: [...file.problems, ...held.problems],
  };
}
