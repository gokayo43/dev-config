import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { allowlistFrom, type Verdict } from "../.github/actions/_lib/gate.ts";
import { routeCompat, SNAPSHOT, snapshotOf } from "../.github/actions/db-gate/route-compat.ts";
import type { Route } from "../route-log.ts";

import { containing } from "./matchers.ts";
import { git, history, materialise, type Tree } from "./tree.ts";

/**
 * The floor is a comparison between three things — the app's own route table,
 * the file this branch committed, and the file the base ref committed — so every
 * case here builds a real two-commit repository and hands the gate a route table
 * beside it. Nothing is stubbed: `git show` at the base ref is the read this
 * whole design rests on.
 */
const HEALTH: Route = { method: "GET", path: "/health" };
const PRESETS: Route = { method: "GET", path: "/presets" };
const WRITE: Route = { method: "POST", path: "/presets" };

const SERVED = [HEALTH, PRESETS, WRITE];

/** A snapshot as the gate writes it, or a file written some other way. */
type Snapshot = readonly Route[] | string;

function text(snapshot: Snapshot): string {
  return typeof snapshot === "string" ? snapshot : snapshotOf(snapshot);
}

interface Scenario {
  /** What the base ref committed; absent — spelled either way — commits no snapshot at all. */
  readonly at?: Snapshot | undefined;
  /** What this branch committed; absent commits no snapshot at all. */
  readonly committed?: Snapshot;
  /**
   * What the working tree holds afterwards, uncommitted. Absent leaves the
   * checkout matching its commit, which is what CI hands the gate; a case sets
   * it to prove that the commit is what gets graded.
   */
  readonly working?: Snapshot;
  /** What the booted app declared. */
  readonly served?: readonly Route[];
  readonly lifecycle?: string;
  readonly retire?: string;
}

interface Driven {
  readonly verdict: Verdict;
  /** The commit the gate compares against, abbreviated the way its diagnostics name it. */
  readonly at: string;
  /** What the run left for the evidence artifact. */
  readonly evidence: string;
}

async function drive(scenario: Scenario): Promise<Driven> {
  const manifest = JSON.stringify({ name: "fixture", lifecycle: scenario.lifecycle ?? "live" });
  const tree = (snapshot: Snapshot | undefined): Tree => ({
    "package.json": manifest,
    ...(snapshot === undefined ? {} : { [SNAPSHOT]: text(snapshot) }),
  });

  const { root, revs } = await history(tree(scenario.at), tree(scenario.committed));
  if (scenario.working !== undefined) {
    await Bun.write(join(root, SNAPSHOT), text(scenario.working));
  }
  const evidence = join(root, "evidence.json");
  const verdict = await routeCompat({
    root,
    // A push with no `before`, which is where `baseRevision` takes the parent
    // commit — the same statement about this checkout as a pull request's merge
    // base, and the one a fixture can make without a remote.
    event: { baseRef: "", before: "" },
    served: scenario.served ?? SERVED,
    retire: allowlistFrom(scenario.retire ?? "", "route-retire"),
    evidence,
  });
  return { verdict, at: (revs[0] ?? "").slice(0, 7), evidence: await Bun.file(evidence).text() };
}

async function problems(scenario: Scenario): Promise<string[]> {
  const { verdict } = await drive(scenario);
  return verdict.problems.map(({ message }) => message);
}

/** One route gone on purpose, with the reason every entry has to carry. */
const RETIRED = "POST /presets -- the write path moved to the jobs API in #412";

/** The state a repo that has adopted the floor and changed nothing is in. */
const SETTLED: Scenario = { at: SERVED, committed: SERVED, served: SERVED };

describe("the snapshot the app keeps honest", () => {
  test("a snapshot that is the app's route table is what a passing run looks like", async () => {
    const { verdict } = await drive(SETTLED);
    expect(verdict.problems).toEqual([]);
    expect(verdict.log).toBeUndefined();
  });

  // The whole point of committing it: the file is the thing a diff shows, and a
  // file nobody has to keep current is a description of an app that stopped
  // existing two releases ago.
  test("a snapshot the app has outgrown is refused, and the content is printed", async () => {
    const { verdict } = await drive({ at: SERVED, committed: [HEALTH], served: SERVED });
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]?.file).toBe(SNAPSHOT);
    expect(verdict.problems[0]?.message).toContain("is not the route table this app serves");
    expect(verdict.log).toBe(snapshotOf(SERVED));
  });

  // Compared byte for byte rather than as a set, so that the file a repo commits
  // is the one this gate generates and regenerating it is a diff of what changed.
  // A set comparison passes every one of these and leaves the file free to drift
  // into a shape no two runs agree on.
  test.each([
    ["the same routes in another order", JSON.stringify([WRITE, PRESETS, HEALTH], undefined, 2)],
    ["the same routes unindented", JSON.stringify(SERVED)],
    ["the same content without its trailing newline", snapshotOf(SERVED).trimEnd()],
  ])("a snapshot that is %s is refused", async (_, committed) => {
    expect(await problems({ at: SERVED, committed, served: SERVED })).toEqual([
      containing("is not the route table this app serves"),
    ]);
  });

  test("a repo with no snapshot is told what it owes and handed the content", async () => {
    const { verdict } = await drive({ at: SERVED, served: SERVED });
    expect(verdict.problems.map(({ message }) => message)).toEqual([
      containing(`this commit carries no ${SNAPSHOT}`),
    ]);
    expect(verdict.log).toBe(snapshotOf(SERVED));
  });

  // What is graded is the blob, because the blob is what the next run reads at
  // the base ref. A gate reading the working tree passes a commit whose snapshot
  // is two releases old whenever the file on disk happens to be right — and the
  // run after it compares against the stale one, which is the drift this floor
  // exists to catch.
  test("a stale committed snapshot is refused however right the working tree is", async () => {
    expect(
      await problems({ at: SERVED, committed: [HEALTH], working: SERVED, served: SERVED }),
    ).toEqual([containing("is not the route table this app serves")]);
  });

  // The other half of the same rule, and the one that makes the untracked case a
  // case of it: a file git does not carry compares against nothing at the base
  // ref forever and appears in no diff. It is not a snapshot, whatever is in it.
  test("a snapshot the commit does not carry is no snapshot at all", async () => {
    expect(await problems({ at: SERVED, working: SERVED, served: SERVED })).toEqual([
      containing(`this commit carries no ${SNAPSHOT}`),
    ]);
  });

  // A checkout filter is the reason this cannot be "the file on disk": with
  // `* text eol=crlf` in .gitattributes the working tree never equals the blob,
  // so a worktree comparison is permanently red with no edit that could clear
  // it. Blob against blob is a comparison a repo can actually satisfy.
  test("a checkout that rewrites line endings is not a difference", async () => {
    const { root } = await history(
      {
        ".gitattributes": "* text eol=crlf\n",
        "package.json": JSON.stringify({ name: "fixture", lifecycle: "dev" }),
        [SNAPSHOT]: snapshotOf(SERVED),
      },
      {
        ".gitattributes": "* text eol=crlf\n",
        "package.json": JSON.stringify({ name: "fixture", lifecycle: "dev" }),
        [SNAPSHOT]: snapshotOf(SERVED),
      },
    );
    // What a checkout under that attribute leaves on disk, which is what the
    // gate must not be reading.
    await Bun.write(join(root, SNAPSHOT), snapshotOf(SERVED).replaceAll("\n", "\r\n"));
    const verdict = await routeCompat({
      root,
      event: { baseRef: "", before: "" },
      served: SERVED,
      retire: allowlistFrom("", "route-retire"),
      evidence: join(root, "evidence.json"),
    });
    expect(verdict.problems).toEqual([]);
  });

  // The gate is the generator, so the content has to leave the run whichever way
  // it went: on a red run it is the file to copy, and on a green one it is what
  // the app declared, for the run after it.
  test("the content is written for the artifact even on a run with nothing to fix", async () => {
    const { evidence } = await drive(SETTLED);
    expect(evidence).toBe(snapshotOf(SERVED));
  });
});

describe("the snapshot's own shape", () => {
  // Sorted by path and then by method, so that the only thing a regenerated file
  // diffs on is a route that changed. Sorting by method first, or not at all,
  // moves half the file whenever a route is added.
  test("the file is sorted by path, then by method", () => {
    // `DELETE /zzz` is what tells the two orderings apart: its method sorts
    // first and its path sorts last, so a file sorted by method leads with it.
    const routes = [
      WRITE,
      { method: "GET", path: "/a/b" },
      { method: "DELETE", path: "/zzz" },
      PRESETS,
      HEALTH,
    ];
    expect(snapshotOf(routes)).toBe(
      `[
  {
    "method": "GET",
    "path": "/a/b"
  },
  {
    "method": "GET",
    "path": "/health"
  },
  {
    "method": "GET",
    "path": "/presets"
  },
  {
    "method": "POST",
    "path": "/presets"
  },
  {
    "method": "DELETE",
    "path": "/zzz"
  }
]
`,
    );
  });

  test("one route is one line however many times the table names it", () => {
    expect(snapshotOf([HEALTH, HEALTH, { method: "get", path: "/health" }])).toBe(
      snapshotOf([HEALTH]),
    );
  });

  // The file states the method the way every comparison here reads it. Writing
  // the router's own spelling instead leaves one line of the file saying
  // `get /health` about a route every diagnostic calls `GET /health`, and which
  // spelling lands depends on which duplicate the table happened to name first.
  test("the method is written as the key spells it, not as the router did", () => {
    expect(snapshotOf([{ method: "get", path: "/health" }])).toContain('"method": "GET"');
  });

  // A route the table names twice is one line, so it is also one route: a count
  // read off the raw table is one higher than the file it is describing.
  test("the count in the note is what the file holds, not what the table named", async () => {
    const { verdict } = await drive({
      at: [HEALTH],
      committed: [HEALTH],
      served: [HEALTH, HEALTH, { method: "get", path: "/health" }],
    });
    expect(verdict.note).toContain("route compatibility: 1 routes served");
  });

  test("an app serving nothing writes an empty list rather than nothing", () => {
    expect(snapshotOf([])).toBe("[]\n");
  });
});

describe("the routes the base ref served", () => {
  test("a route the base ref served and this branch still serves is held", async () => {
    const { verdict, at } = await drive(SETTLED);
    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toBe(
      `route compatibility: 3 routes served; of the 3 at ${at}, 3 still served and 0 retired`,
    );
  });

  // The floor itself. Nothing else in the database job notices a route that
  // stopped being registered: the app boots, the ramp runs, and the coverage
  // floor is happy because what is gone is not in the table it grades.
  // The diagnostic carries the way out, filled in for the route it is about. A
  // reader of the red has one edit to make and should be able to copy it: an
  // implementation that names the input without showing the line sends them to
  // a docs page to work out a grammar.
  test("the refusal shows the route-retire line that would sanction it", async () => {
    const [message = ""] = await problems({
      at: SERVED,
      committed: [HEALTH, PRESETS],
      served: [HEALTH, PRESETS],
    });
    expect(message).toContain("route-retire");
    expect(message).toContain("'POST /presets -- ");
  });

  test("a route the base ref served and this branch does not is refused", async () => {
    expect(
      await problems({ at: SERVED, committed: [HEALTH, PRESETS], served: [HEALTH, PRESETS] }),
    ).toEqual([containing("POST /presets was served at")]);
  });

  test("a route this branch adds is free", async () => {
    const grown = [...SERVED, { method: "DELETE", path: "/presets/:id" }];
    expect(await problems({ at: SERVED, committed: grown, served: grown })).toEqual([]);
  });

  // A rename is a removal and an addition, and only the removal is a promise
  // broken: whoever was calling the old path still is.
  test("a renamed path is the removal it is, not a route that moved", async () => {
    const renamed = [HEALTH, { method: "GET", path: "/presets/all" }, WRITE];
    expect(await problems({ at: SERVED, committed: renamed, served: renamed })).toEqual([
      containing("GET /presets was served at"),
    ]);
  });

  test("a route registered for every method covers the methods the base ref served", async () => {
    const catchAll = [{ method: "ALL", path: "/presets" }, HEALTH];
    expect(await problems({ at: SERVED, committed: catchAll, served: catchAll })).toEqual([]);
  });

  // The other direction is a removal: a base ref answering every method on a
  // path and a branch answering one has stopped answering the rest. Reading
  // "is this path still here" instead of "is this route still here" passes it.
  test("a catch-all narrowed to one method is a removal", async () => {
    const was = [{ method: "ALL", path: "/events" }];
    expect(
      await problems({
        at: was,
        committed: [{ method: "GET", path: "/events" }],
        served: [{ method: "GET", path: "/events" }],
      }),
    ).toEqual([containing("ALL /events was served at")]);
  });

  // First adoption: the base ref predates the file, so there is nothing to hold
  // this branch to and nothing to report. The branch still owes its own
  // snapshot, which is the diff that adopts the floor.
  test("a base ref with no snapshot compares nothing and passes", async () => {
    const { verdict, at } = await drive({ committed: SERVED, served: SERVED });
    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toContain(`${at} carried no ${SNAPSHOT}`);
  });

  // Everything above is what a repo carrying people owes. A repo with nobody on
  // the other end may drop a route at will, and the note says the rule did not
  // run rather than leaving a green step to be read as a pass.
  test("a dev repo may stop serving a route, and is told the rule did not run", async () => {
    const { verdict } = await drive({
      at: SERVED,
      committed: [HEALTH],
      served: [HEALTH],
      lifecycle: "dev",
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toContain("does not read live");
  });

  test("a repo that declares no lifecycle at all holds nothing to the base ref", async () => {
    const tree: Tree = { "package.json": JSON.stringify({ name: "fixture" }) };
    const { root } = await history(tree, tree);
    const verdict = await routeCompat({
      root,
      event: { baseRef: "", before: "" },
      served: [],
      retire: allowlistFrom("", "route-retire"),
      evidence: join(root, "evidence.json"),
    });
    expect(verdict.problems.map(({ message }) => message)).toEqual([
      containing(`this commit carries no ${SNAPSHOT}`),
    ]);
    expect(verdict.note).toContain("does not read live");
  });

  // A base snapshot that will not read is a file somebody hand-edited past the
  // gate that generates it. Read as "the base ref served nothing" it passes every
  // route in the world as still served, which is the floor answering the
  // opposite of the question.
  test.each([
    ["not json at all", "{", "is not JSON"],
    ["an object", "{}", "the top level is an object"],
    ["a list of something else", '["GET /health"]', 'which is not a {"method","path"} pair'],
  ])("a base snapshot that is %s is refused rather than read as empty", async (_, at, detail) => {
    expect(drive({ at, committed: SERVED, served: SERVED })).rejects.toThrow(detail);
  });

  // The one state that must not read as an honest pass. A checkout with no
  // history cannot say what was served before, which is not the same as nothing
  // having been served — and this is the lifecycle the whole floor exists for,
  // so an implementation reading the refusal as "nothing to compare" switches
  // the gate off exactly where it is needed. One diagnostic, too: the fix is the
  // checkout, and route-retire going unread is a consequence of it.
  test.each([
    ["with nothing retired", ""],
    ["with routes retired, which nothing can grade either", RETIRED],
  ])(
    "a live repo whose checkout cannot name a base ref is refused, not passed (%s)",
    async (_, retire) => {
      const manifest = JSON.stringify({ name: "fixture", lifecycle: "live" });
      const full: Tree = { "package.json": manifest, [SNAPSHOT]: snapshotOf(SERVED) };
      const { root } = await history(full, full);
      const host = await materialise({});
      // A path clone hardlinks and ignores --depth; file:// is what actually
      // produces the shallow checkout this case is about.
      await git(host, ["clone", "--depth", "1", "--quiet", `file://${root}`, "shallow"]);

      const verdict = await routeCompat({
        root: join(host, "shallow"),
        event: { baseRef: "", before: "" },
        served: SERVED,
        retire: allowlistFrom(retire, "route-retire"),
        evidence: join(host, "evidence.json"),
      });
      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]?.message).toContain("check out with fetch-depth: 0");
      expect(verdict.problems[0]?.message).not.toContain("route-retire");
      // The refusal already says the whole of it, so the note says only what it
      // does not — what this app serves. A note repeating the error is one line
      // of log saying nothing twice.
      expect(verdict.note).toBe("route compatibility: 3 routes served");
    },
  );

  // The other way a base ref stops being readable, and the reason `git show`
  // alone cannot be the read: it exits non-zero both for a commit that never had
  // the file and for a commit whose blob this checkout does not hold. Read as
  // the first, the second passes every route in the world as still served — and
  // a blobless clone (`--filter=blob:none`) whose promisor is unreachable is
  // exactly a checkout with the trees and none of the contents.
  test("a base ref whose snapshot object is missing is refused, not read as absent", async () => {
    const manifest = JSON.stringify({ name: "fixture", lifecycle: "live" });
    const grown = [...SERVED, { method: "DELETE", path: "/presets/:id" }];
    const { root, revs } = await history(
      { "package.json": manifest, [SNAPSHOT]: snapshotOf(SERVED) },
      { "package.json": manifest, [SNAPSHOT]: snapshotOf(grown) },
    );
    // The base commit's own blob, which HEAD's differs from — so removing it
    // leaves the tree listing that path and the contents unreadable, which is
    // the state being graded.
    const blob = (await git(root, ["rev-parse", `${revs[0] ?? ""}:${SNAPSHOT}`])).trim();
    await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    const verdict = await routeCompat({
      root,
      event: { baseRef: "", before: "" },
      served: grown,
      retire: allowlistFrom("", "route-retire"),
      evidence: join(root, "evidence.json"),
    });
    expect(verdict.problems.map(({ message }) => message)).toEqual([
      containing("cannot read its contents"),
    ]);
  });

  test("the manifest deciding all of this is refused rather than read as dev", async () => {
    const { root } = await history({}, {});
    expect(
      routeCompat({
        root,
        event: { baseRef: "", before: "" },
        served: [],
        retire: allowlistFrom("", "route-retire"),
        evidence: join(root, "evidence.json"),
      }),
    ).rejects.toThrow("package.json could not be read");
  });
});

describe("retiring a route deliberately", () => {
  test("a route named with a reason is gone on purpose and passes", async () => {
    const { verdict, at } = await drive({
      at: SERVED,
      committed: [HEALTH, PRESETS],
      served: [HEALTH, PRESETS],
      retire: RETIRED,
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toBe(
      `route compatibility: 2 routes served; of the 3 at ${at}, 2 still served and 1 retired`,
    );
  });

  // One line written twice is one exemption. Grading the entries as written
  // hands the reader two identical annotations for one edit, which is the shape
  // of a gate people learn to skim.
  test("the same entry written twice earns one diagnostic, not two", async () => {
    expect(await problems({ ...SETTLED, retire: `${RETIRED}\n${RETIRED}` })).toEqual([
      containing("route-retire retires POST /presets, which this app still serves"),
    ]);
  });

  test("an entry that retires nothing, because the route is still served, is refused", async () => {
    expect(await problems({ ...SETTLED, retire: RETIRED })).toEqual([
      containing("route-retire retires POST /presets, which this app still serves"),
    ]);
  });

  // The same rot the ramp's allowlist is held to: an entry naming a route the
  // base ref never served waives nothing and is left behind by whoever wrote it.
  test("an entry naming a route the base ref did not serve is refused", async () => {
    const { verdict, at } = await drive({
      ...SETTLED,
      retire: "DELETE /gone -- retired two releases ago",
    });
    expect(verdict.problems.map(({ message }) => message)).toEqual([
      containing(`route-retire names DELETE /gone, which ${at} did not serve`),
    ]);
  });

  test.each(["/presets -- no method", "POST -- no path", "POST /a /b -- two paths"])(
    "an entry that is not a route (%s) says so",
    async (retire) => {
      expect(await problems({ ...SETTLED, retire })).toEqual([
        containing("is not a route — write 'METHOD /path -- why'"),
      ]);
    },
  );

  // The price of the hatch, and one mistake earning one diagnostic: an entry
  // whose author is going back to that line anyway is not also told the route is
  // still served, and it still retires its route so the floor does not report
  // the removal on top.
  test("an entry with no reason is refused for that and asked nothing else", async () => {
    expect(
      await problems({
        at: SERVED,
        committed: [HEALTH, PRESETS],
        served: [HEALTH, PRESETS],
        retire: "POST /presets",
      }),
    ).toEqual([containing("route-retire waives POST /presets without saying why")]);
  });

  test("the method is read in either case, the way the app's own table is", async () => {
    expect(
      await problems({
        at: SERVED,
        committed: [HEALTH, PRESETS],
        served: [HEALTH, PRESETS],
        retire: "post /presets -- the write path moved to the jobs API in #412",
      }),
    ).toEqual([]);
  });

  // An input nothing is going to read is the failure every guard in check.yml
  // exists to prevent, one layer down: the repo has written out which routes it
  // retired, and on a repo whose base ref is not being read that sentence lands
  // nowhere.
  test.each([
    ["a dev repo", { lifecycle: "dev" }],
    ["a base ref with no snapshot", { at: undefined }],
  ])("route-retire on %s is refused rather than ignored", async (_, scenario) => {
    expect(await problems({ ...SETTLED, ...scenario, retire: RETIRED })).toEqual([
      containing("route-retire is set and nothing reads it"),
    ]);
  });

  test("a repo passing no route-retire at all is not told anything about it", async () => {
    expect(await problems({ ...SETTLED, lifecycle: "dev" })).toEqual([]);
  });
});
