/**
 * The dev-server CLI, against real git worktrees and real detached processes.
 *
 * Real time is spent here on purpose and it is the one suite in this repo that
 * has to: what is being graded is a child process reaching a listening socket
 * and a signal reaching a process group, neither of which any injected clock
 * has a part in. Every wait is bounded by `DEV_SERVER_READY_TIMEOUT_MS`, which
 * the fixture sets on every invocation — twenty seconds where a server is meant
 * to come up, two where the case is about one that never does.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { basePort, freePort, inBlock, PORTS_PER_WORKTREE, worktreeSlug } from "../dev-server.ts";
import {
  answers,
  killBehindItsBack,
  NEVER_BINDS,
  occupy,
  running,
  scratchRepo,
  SERVES,
  settles,
} from "./dev-server-fixture.ts";

/** Long enough for `bun run dev` to boot a fixture server, short enough to fail a hung suite. */
const CASE_MS = 60_000;

describe("the derivation", () => {
  test("reduces a branch to something a filename can carry", () => {
    // The wrong implementation this kills writes a record at
    // `<state>/feat/add-thing.json` — a directory that does not exist — or one
    // whose name starts with a digit where the block below expects a word.
    expect(worktreeSlug("feat/Add-Thing")).toBe("feat_add_thing");
    expect(worktreeSlug("release/2.0")).toBe("release_2_0");
    expect(worktreeSlug("--wip--")).toBe("wip");
    expect(worktreeSlug("2026-plan")).toBe("w_2026_plan");
    expect(worktreeSlug("///")).toBe("w_");
  });

  test("puts every worktree on its own aligned block inside the range", () => {
    // The wrong implementation: a base that is not a multiple of the block
    // size. Blocks then overlap, and the first free port of one branch is the
    // second port of another's — which is how two worktrees end up sharing one.
    for (const branch of ["main", "feat/x", "dev-server", "renovate/oxlint", "w"]) {
      const base = basePort("@gokayo43/dev-config", branch);
      expect(base).toBeGreaterThanOrEqual(20_000);
      expect(base).toBeLessThan(60_000);
      expect((base - 20_000) % PORTS_PER_WORKTREE).toBe(0);
    }
  });

  test("derives from the package as well as the branch", () => {
    // The wrong implementation is the obvious one: hash the branch alone. Every
    // repo on a machine has a `main`, so two of them would then serve out of one
    // block and the second `up` would land beside the first repo's server.
    expect(basePort("shop", "main")).not.toBe(basePort("warehouse", "main"));
    expect(basePort("shop", "main")).not.toBe(basePort("shop", "feature"));
  });

  test("is reproducible, which is what lets a README state a port", () => {
    // Pinned so a change to the hash is a failing test rather than every
    // worktree on this fleet silently moving to a new port.
    expect(basePort("scratch-app", "main")).toBe(57_510);
    expect(basePort("scratch-app", "feature-x")).toBe(42_070);
  });

  test("counts a port as this block's only while it is inside it", () => {
    // The wrong implementation is `port <= base + PORTS_PER_WORKTREE`, which
    // adopts the first port of the next block — so a record written by another
    // branch is reused instead of re-derived.
    expect(inBlock(20_000, 20_000)).toBe(true);
    expect(inBlock(20_000, 20_009)).toBe(true);
    expect(inBlock(20_000, 20_010)).toBe(false);
    expect(inBlock(20_000, 19_999)).toBe(false);
  });

  test("claims the first free port in the block, and refuses when there is none", async () => {
    // Two wrong implementations. One searches from wherever the last port
    // landed, which walks out of the block into the one another branch owns;
    // the other hands back a busy port because it never probed.
    const busy = new Set([20_000, 20_001, 20_003]);
    const free = async (port: number): Promise<boolean> => !busy.has(port);
    expect(await freePort(20_000, free)).toBe(20_002);
    expect(await freePort(20_003, free)).toBe(20_004);
    let refusal = "";
    try {
      await freePort(20_000, async () => false);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("20000-20009");
  });
});

describe("up", () => {
  test(
    "gives each worktree its own port, and each answers on it",
    async () => {
      // The wrong implementation is the one every repo has today: one hardcoded
      // port, so the second worktree either fails to bind or serves the first
      // one's code. This also kills an `up` that prints a URL before the server
      // answers — the fetch below is made the moment `up` returns.
      await using scratch = await scratchRepo(SERVES);
      const feature = await scratch.worktree("feature");

      const first = await scratch.devServer(scratch.root, "up");
      const second = await scratch.devServer(feature, "up");

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const main = await scratch.record("main");
      const other = await scratch.record("feature");
      expect(first.stdout.trim()).toBe(`http://127.0.0.1:${main?.port}`);
      expect(second.stdout.trim()).toBe(`http://127.0.0.1:${other?.port}`);
      expect(main?.port).not.toBe(other?.port);
      expect(await answers(main?.port ?? 0)).toBe(true);
      expect(await answers(other?.port ?? 0)).toBe(true);
    },
    CASE_MS,
  );

  test(
    "writes down everything another command needs to find the process again",
    async () => {
      // The record is the whole of this tool's memory: a field missing from it
      // is a server nothing can stop, and a wrong `worktree` is a record `sweep`
      // either never collects or collects while its worktree is still there.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");

      const record = await scratch.record("main");
      expect(record?.worktree).toBe(scratch.root);
      expect(record?.branch).toBe("main");
      expect(record?.packageName).toMatch(/^dev-server-fixture-/);
      expect(record?.log).toBe(join(scratch.state, "main.log"));
      expect(record?.port).toBe(basePort(record?.packageName ?? "", "main"));
      expect(running(record?.pid ?? 0)).toBe(true);
      expect(Date.parse(record?.startedAt ?? "")).toBeGreaterThan(0);
    },
    CASE_MS,
  );

  test(
    "is a no-op while the server is answering",
    async () => {
      // The wrong implementation spawns anyway. The first child keeps the port,
      // the second cannot bind it, and the record now names a process that is
      // not the one serving — so `down` leaves a server running.
      await using scratch = await scratchRepo(SERVES);
      const started = await scratch.devServer(scratch.root, "up");
      const before = await scratch.record("main");

      const again = await scratch.devServer(scratch.root, "up");

      expect(again.code).toBe(0);
      expect(again.stdout).toBe(started.stdout);
      expect((await scratch.record("main"))?.pid).toBe(before?.pid);
    },
    CASE_MS,
  );

  test(
    "comes back to the same port after a stop",
    async () => {
      // The wrong implementation probes for a free port every time. It works,
      // and it silently breaks the one property the derivation exists for: a
      // bookmark, or a printed URL, is still this worktree's tomorrow.
      await using scratch = await scratchRepo(SERVES);
      const first = await scratch.devServer(scratch.root, "up");
      await scratch.devServer(scratch.root, "down");

      const second = await scratch.devServer(scratch.root, "up");

      expect(second.stdout.trim()).toBe(first.stdout.trim());
    },
    CASE_MS,
  );

  test(
    "restarts cleanly after the server is killed behind its back",
    async () => {
      // The wrong implementation trusts the record: it reads a pid, believes the
      // server is up, and prints a URL nothing answers on. `status` has the same
      // bug from the other side if it reports a record's existence as liveness.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");
      const before = await scratch.record("main");
      killBehindItsBack(before?.pid ?? 0);
      expect(await settles(() => !running(before?.pid ?? 0))).toBe(true);

      const dead = await scratch.devServer(scratch.root, "status");
      const restarted = await scratch.devServer(scratch.root, "up");

      expect(dead.stdout).toContain("dead");
      expect(dead.stdout).toContain("silent");
      expect(restarted.code).toBe(0);
      const after = await scratch.record("main");
      expect(after?.port).toBe(before?.port);
      expect(after?.pid).not.toBe(before?.pid);
      expect(await answers(after?.port ?? 0)).toBe(true);
    },
    CASE_MS,
  );

  test(
    "refuses a claimed port somebody else is listening on, rather than moving",
    async () => {
      // The wrong implementation falls forward to the next free port. `up` keeps
      // working, and the worktree's URL has quietly changed — which is the
      // property the case above is about, broken by the recovery path instead.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");
      const before = await scratch.record("main");
      killBehindItsBack(before?.pid ?? 0);
      expect(await settles(async () => !(await answers(before?.port ?? 0)))).toBe(true);

      using foreign = occupy(before?.port ?? 0);
      expect(foreign).toBeDefined();
      const refused = await scratch.devServer(scratch.root, "up");

      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(String(before?.port));
      expect(refused.stderr).toContain("lsof");
      expect((await scratch.record("main"))?.port).toBe(before?.port);
    },
    CASE_MS,
  );

  test(
    "gives up on a dev script that never answers, and leaves nothing running",
    async () => {
      // The wrong implementation waits forever, or gives up and walks away from
      // the child — which then holds the port, so every later `up` in this
      // worktree refuses a port nothing will ever answer on.
      await using scratch = await scratchRepo(NEVER_BINDS, 2000);

      const timedOut = await scratch.devServer(scratch.root, "up");

      expect(timedOut.code).toBe(1);
      expect(timedOut.stderr).toContain("did not answer");
      expect(timedOut.stderr).toContain("binding nothing");
      expect(await scratch.record("main")).toBeNull();
    },
    CASE_MS,
  );
});

describe("the other commands", () => {
  test(
    "url answers for this worktree, and exits 1 once nothing is up",
    async () => {
      // The wrong implementation prints whatever the record says. After `down`
      // there is nothing to print, and a script piping this into a browser would
      // open a port that is now somebody else's.
      await using scratch = await scratchRepo(SERVES);
      const started = await scratch.devServer(scratch.root, "up");

      const up = await scratch.devServer(scratch.root, "url");
      await scratch.devServer(scratch.root, "down");
      const gone = await scratch.devServer(scratch.root, "url");

      expect(up.code).toBe(0);
      expect(up.stdout.trim()).toBe(started.stdout.trim());
      expect(gone.code).toBe(1);
      expect(gone.stdout).toBe("");
    },
    CASE_MS,
  );

  test(
    "status reports every server the repository has, not just this worktree's",
    async () => {
      // The wrong implementation reads the current worktree's record only —
      // which is exactly the state nobody can act on, because the server you
      // have forgotten about is the one in the worktree you are not standing in.
      await using scratch = await scratchRepo(SERVES);
      const feature = await scratch.worktree("feature");
      await scratch.devServer(scratch.root, "up");
      await scratch.devServer(feature, "up");

      const listed = await scratch.devServer(scratch.root, "status");

      const main = await scratch.record("main");
      const other = await scratch.record("feature");
      expect(listed.stdout).toContain(scratch.root);
      expect(listed.stdout).toContain(feature);
      for (const server of [main, other]) {
        expect(listed.stdout).toContain(String(server?.port));
        expect(listed.stdout).toContain(String(server?.pid));
      }
      expect(listed.stdout).toContain("main");
      expect(listed.stdout).toContain("feature");
      expect(listed.stdout.match(/alive/g)).toHaveLength(2);
      expect(listed.stdout.match(/answering/g)).toHaveLength(2);
    },
    CASE_MS,
  );

  test(
    "logs prints this worktree's log and no other's",
    async () => {
      // The wrong implementation prints every log the repository has, the way
      // `status` prints every record — so the one thing a person came here to
      // read is buried under another worktree's. That the log is keyed by branch
      // at all is held by the record case above.
      await using scratch = await scratchRepo(SERVES);
      const feature = await scratch.worktree("feature");
      await scratch.devServer(scratch.root, "up");
      await scratch.devServer(feature, "up");

      const mine = await scratch.devServer(feature, "logs");

      const other = await scratch.record("feature");
      expect(mine.code).toBe(0);
      expect(mine.stdout).toContain(`fixture serving on 127.0.0.1:${other?.port}`);
      expect(mine.stdout).not.toContain(`:${(await scratch.record("main"))?.port}`);
    },
    CASE_MS,
  );

  test(
    "down stops the process and exits 0 when there was nothing to stop",
    async () => {
      // The wrong implementation deletes the record and reports success while
      // the server goes on serving: the caller is told a thing happened that did
      // not, and the port stays held by a process nothing can find any more.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");
      const server = await scratch.record("main");

      const stopped = await scratch.devServer(scratch.root, "down");
      const again = await scratch.devServer(scratch.root, "down");

      expect(stopped.code).toBe(0);
      expect(again.code).toBe(0);
      expect(await settles(() => !running(server?.pid ?? 0))).toBe(true);
      expect(await answers(server?.port ?? 0)).toBe(false);
      expect(await scratch.record("main")).toBeNull();
    },
    CASE_MS,
  );

  test(
    "sweep collects the worktrees that are gone and leaves the rest alone",
    async () => {
      // Two wrong implementations. One drops the record without signalling, and
      // the server of a worktree nobody can stand in any more runs until the box
      // reboots. The other reads "is this worktree the one I am in?" and takes
      // down every server but its own.
      await using scratch = await scratchRepo(SERVES);
      const feature = await scratch.worktree("feature");
      await scratch.devServer(scratch.root, "up");
      await scratch.devServer(feature, "up");
      const kept = await scratch.record("main");
      const doomed = await scratch.record("feature");

      const removed = Bun.spawnSync(["git", "worktree", "remove", "--force", feature], {
        cwd: scratch.root,
      });
      expect(removed.exitCode).toBe(0);
      const swept = await scratch.devServer(scratch.root, "sweep");

      expect(swept.code).toBe(0);
      expect(swept.stderr).toContain(feature);
      expect(await settles(() => !running(doomed?.pid ?? 0))).toBe(true);
      expect(await scratch.record("feature")).toBeNull();
      expect(running(kept?.pid ?? 0)).toBe(true);
      expect(await answers(kept?.port ?? 0)).toBe(true);
      expect(await scratch.record("main")).not.toBeNull();
    },
    CASE_MS,
  );
});

describe("the package", () => {
  test("ships the CLI and gives it the name the commands are typed under", async () => {
    // The wrong implementation is a file that works and that nobody can reach:
    // omitted from `files` it is not published, omitted from `bin` there is no
    // `dev-server` for `bun run` to find in a consuming repo's node_modules.
    const parsed: unknown = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("files" in parsed && "exports" in parsed && "bin" in parsed)
    ) {
      throw new Error("package.json declares no files, exports or bin");
    }
    expect(parsed.files).toContain("dev-server.ts");
    expect(parsed.exports).toHaveProperty(["./dev-server.ts"], "./dev-server.ts");
    expect(parsed.bin).toEqual({ "dev-server": "./dev-server.ts" });
  });
});
