/**
 * The dev-server CLI, against real git worktrees and real detached processes.
 *
 * Real time is spent here on purpose and it is the one suite in this repo that
 * has to: what is being graded is a child process reaching a listening socket, a
 * signal reaching a process group, and two invocations racing each other, none
 * of which any injected clock has a part in. Every wait is bounded by
 * `DEV_SERVER_READY_TIMEOUT_MS`, which the fixture sets on every invocation —
 * twenty seconds where a server is meant to come up, two where the case is about
 * one that never does.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  basePort,
  freePort,
  inBlock,
  PORT_CEILING,
  PORT_FLOOR,
  PORTS_PER_WORKTREE,
  recordStem,
  worktreeSlug,
} from "../dev-server-derive.ts";
import {
  answers,
  bystander,
  EXITS_AT_ONCE,
  holderOf,
  killBehindItsBack,
  NEVER_BINDS,
  occupy,
  running,
  scratchRepo,
  SERVES,
  SERVES_EVERYWHERE,
  settled,
  settles,
  stays,
} from "./dev-server-fixture.ts";

/** Long enough for `bun run dev` to boot a fixture server, short enough to fail a hung suite. */
const CASE_MS = 60_000;

/** A worktree on a branch, as the two derivations take one. */
const named = (worktree: string, branch: string) => ({ worktree, branch, detached: false });

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

  test("names a record after the worktree, not after what a branch reduces to", () => {
    // The wrong implementation keys the record on the slug alone. `feat/x` and
    // `feat-x` reduce to one name, so two live worktrees share one record: the
    // second `up` prints the first's URL, and `down` in either stops the other's
    // server. Measured before this changed.
    expect(worktreeSlug("feat/x")).toBe(worktreeSlug("feat-x"));
    expect(recordStem("/w/one", "feat/x")).not.toBe(recordStem("/w/two", "feat-x"));
    expect(recordStem("/w/one", "feat/x")).toStartWith("feat_x-");
    expect(recordStem("/w/one", "main")).toBe(recordStem("/w/one", "main"));
    expect(recordStem("/w/one", "main")).not.toBe(recordStem("/w/two", "main"));
  });

  test("puts every worktree on its own aligned block inside the range", () => {
    // The wrong implementation: a base that is not a multiple of the block size.
    // Blocks then overlap, and the first free port of one branch is the second
    // port of another's — which is how two worktrees end up sharing one.
    for (const branch of ["main", "feat/x", "dev-server", "renovate/oxlint", "w"]) {
      const base = basePort("@gokayo43/dev-config", named("/w", branch));
      expect(base).toBeGreaterThanOrEqual(PORT_FLOOR);
      expect(base).toBeLessThan(PORT_CEILING);
      expect((base - PORT_FLOOR) % PORTS_PER_WORKTREE).toBe(0);
    }
  });

  test("derives a port from the package and from the branch as git spells it", () => {
    // Two wrong implementations. Hashing the branch alone puts every repo's
    // `main` in one block. Hashing the SLUG puts `feat/x` and `feat-x` in one
    // block, which is the same collision one layer down from the record name.
    expect(basePort("shop", named("/w", "main"))).not.toBe(
      basePort("warehouse", named("/w", "main")),
    );
    expect(basePort("shop", named("/w", "main"))).not.toBe(
      basePort("shop", named("/w", "feature")),
    );
    expect(basePort("shop", named("/w1", "feat/x"))).not.toBe(
      basePort("shop", named("/w2", "feat-x")),
    );
  });

  test("derives a detached worktree's port from its path, which is all it has", () => {
    // The wrong implementation hashes the short commit. Two worktrees detached
    // at one commit have the same one, so they land on one block and one of them
    // serves the other's code.
    const commit = "a1b2c3d";
    const one = { worktree: "/w/one", branch: commit, detached: true };
    const two = { worktree: "/w/two", branch: commit, detached: true };
    expect(basePort("shop", one)).not.toBe(basePort("shop", two));
    expect(basePort("shop", one)).toBe(basePort("shop", { ...one }));
  });

  test("is reproducible, which is what lets a README state a port", () => {
    // Pinned so a change to the hash is a failing test rather than every
    // worktree on this fleet silently moving to a new port.
    expect(basePort("scratch-app", named("/w", "main"))).toBe(58_090);
    expect(basePort("scratch-app", named("/w", "feature-x"))).toBe(25_750);
  });

  test("counts a port as this block's only while it is inside it", () => {
    // The wrong implementation is `port <= base + PORTS_PER_WORKTREE`, which
    // adopts the first port of the next block — so a record written by another
    // worktree is reused instead of re-derived.
    expect(inBlock(20_000, 20_000)).toBe(true);
    expect(inBlock(20_000, 20_009)).toBe(true);
    expect(inBlock(20_000, 20_010)).toBe(false);
    expect(inBlock(20_000, 19_999)).toBe(false);
  });

  test("claims the first free port in the block, and refuses when there is none", async () => {
    // Two wrong implementations. One searches from wherever the last port
    // landed, which walks out of the block into the one another branch owns; the
    // other hands back a busy port because it never probed.
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
      expect(first.stdout.trim()).toBe(`http://127.0.0.1:${main.port}`);
      expect(second.stdout.trim()).toBe(`http://127.0.0.1:${other.port}`);
      expect(main.port).not.toBe(other.port);
      expect(await answers(main.port)).toBe(true);
      expect(await answers(other.port)).toBe(true);
    },
    CASE_MS,
  );

  test(
    "keeps two worktrees apart when their branches reduce to one name",
    async () => {
      // The whole of the identity collision, end to end. Before the record was
      // keyed on the worktree, `feat/x` and `feat-x` shared one record and one
      // port: `up` in the second printed the first's URL, `status` showed one
      // server, and `down` in the second killed the first's.
      await using scratch = await scratchRepo(SERVES);
      const one = await scratch.worktree("feat/x");
      const two = await scratch.worktree("feat-x");

      const first = await scratch.devServer(one, "up");
      const second = await scratch.devServer(two, "up");

      expect(first.stdout.trim()).not.toBe(second.stdout.trim());
      const kept = await scratch.record("feat/x");
      const doomed = await scratch.record("feat-x");
      expect(kept.worktree).toBe(one);
      expect(doomed.worktree).toBe(two);
      const listed = await scratch.devServer(scratch.root, "status");
      expect(listed.stdout).toContain(one);
      expect(listed.stdout).toContain(two);

      await scratch.devServer(two, "down");

      expect(running(kept.pid)).toBe(true);
      expect(await answers(kept.port)).toBe(true);
      expect(await settles(async () => !(await answers(doomed.port)))).toBe(true);
    },
    CASE_MS,
  );

  test(
    "refuses a record that names another worktree",
    async () => {
      // A 32-bit tag is short enough to owe this check. Without it a collision is
      // silent, and the command acts on a server in a checkout it is not standing
      // in — which is the failure the tag exists to make unlikely, not impossible.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");
      const server = await scratch.record("main");
      await scratch.putRecord(
        "main",
        JSON.stringify({ ...server, worktree: "/somewhere/else" }, null, 2),
      );

      const refusedUp = await scratch.devServer(scratch.root, "up");
      const refusedDown = await scratch.devServer(scratch.root, "down");

      for (const refused of [refusedUp, refusedDown]) {
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("/somewhere/else");
      }
      expect(running(server.pid)).toBe(true);
    },
    CASE_MS,
  );

  test(
    "waits while another `up` holds this worktree, and takes a lock nobody holds",
    async () => {
      // The deterministic half of the exclusion. Without a lock consulted at all,
      // `up` starts a server while another one is mid-flight in the same
      // worktree; with a lock nobody can release, a worktree can never be started
      // again — so a holder that is gone has to be stepped over rather than
      // waited on, and both halves are asserted here rather than raced for.
      await using scratch = await scratchRepo(SERVES);
      using holder = await bystander();
      await scratch.putLock("main", JSON.stringify(await holderOf(holder.pid)));

      const pending = scratch.devServer(scratch.root, "up");
      const waited = await stays(async () => (await scratch.recordOrNull("main")) === null);
      await rm(scratch.paths("main").lock, { force: true });
      const started = await pending;

      expect(waited).toBe(true);
      expect(started.code).toBe(0);

      await scratch.devServer(scratch.root, "down");
      const gone = await bystander();
      const stale = await holderOf(gone.pid);
      killBehindItsBack(gone.pid);
      expect(await settles(() => !running(stale.pid))).toBe(true);
      await scratch.putLock("main", JSON.stringify(stale));

      const stolen = await scratch.devServer(scratch.root, "up");

      expect(stolen.code).toBe(0);
      expect(stolen.stdout.trim()).toBe(started.stdout.trim());
    },
    CASE_MS,
  );

  test(
    "says a dev script exited rather than waiting out the clock for it",
    async () => {
      // Readiness that only watches the port and the deadline reports "did not
      // answer" after the full timeout for a script that died on its first line —
      // the timeout being the only thing that ever ends the wait. Watching the
      // child ends it at the moment there is something to say.
      await using scratch = await scratchRepo(EXITS_AT_ONCE);

      const failed = await scratch.devServer(scratch.root, "up");

      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("exited before it");
      expect(failed.stderr).not.toContain("did not answer");
      expect(failed.stderr).toContain("boom: the dev script could not start");
      expect(await scratch.recordOrNull("main")).toBeNull();
    },
    CASE_MS,
  );

  test(
    "two `up`s racing in one worktree leave exactly one server",
    async () => {
      // The end-to-end shape of it: two people, or an agent and a person, running
      // `up` at once. Measured before the lock, five concurrent pairs each left
      // two servers on two ports with one record between them. The window is
      // narrow enough now that this case cannot be relied on to open it — the
      // case above is the deterministic one — so what this pins is the outcome:
      // one agreed URL and one spawn.
      await using scratch = await scratchRepo(SERVES);

      const [first, second] = await scratch.devServerRace(scratch.root, "up");

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.stdout.trim()).toBe(second.stdout.trim());
      const server = await scratch.record("main");
      // One spawn, counted where a spawn is written down. Reading the block for
      // listeners would answer the same question and give a foreign process on a
      // neighbouring port a vote in it.
      const log = await readFile(server.log, "utf8");
      expect(log.match(/=== dev-server up /g)).toHaveLength(1);
      expect(await answers(server.port)).toBe(true);
    },
    CASE_MS,
  );

  test(
    "writes down everything another command needs to find the process again",
    async () => {
      // The record is the whole of this tool's memory: a field missing from it is
      // a server nothing can stop, and a wrong `worktree` is a record `sweep`
      // either never collects or collects while its worktree is still there.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");

      const record = await scratch.record("main");
      expect(record.worktree).toBe(scratch.root);
      expect(record.branch).toBe("main");
      expect(record.packageName).toMatch(/^dev-server-fixture-/);
      expect(record.log).toBe(scratch.paths("main").log);
      expect(record.port).toBe(basePort(record.packageName, named(scratch.root, "main")));
      expect(record.bootId).toBe(
        (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      );
      expect(record.startTicks).toBeGreaterThan(0);
      expect(running(record.pid)).toBe(true);
      expect(Date.parse(record.startedAt)).toBeGreaterThan(0);
      // The log holds whatever the dev script printed, and the child was handed
      // the whole environment with both streams pointed here: a stack trace with
      // a connection string in it must not be world-readable inside `.git`.
      expect((await stat(record.log)).mode & 0o777).toBe(0o600);
      expect((await stat(scratch.state)).mode & 0o777).toBe(0o700);
      expect((await stat(scratch.paths("main").record)).mode & 0o777).toBe(0o600);
    },
    CASE_MS,
  );

  test(
    "hands the dev script every name it promises, and only loopback",
    async () => {
      // The wrong implementation drops one of the four. Nothing in the repo's own
      // `dev` script would fail — it would simply run on a port or an origin the
      // CLI never told it about, which is a URL that is right by luck.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");

      const server = await scratch.record("main");
      const log = await readFile(server.log, "utf8");
      expect(log).toContain(`fixture PORT=${server.port}`);
      expect(log).toContain(`fixture DEV_PORT=${server.port}`);
      expect(log).toContain("fixture HOST=127.0.0.1");
      expect(log).toContain(`fixture SITE_URL=http://127.0.0.1:${server.port}`);
    },
    CASE_MS,
  );

  test(
    "stops a dev script that binds every interface instead of $HOST",
    async () => {
      // `HOST` is a request. A dev script that binds 0.0.0.0 answers on every
      // address this machine has — a colleague's laptop on the same LAN, a
      // WireGuard peer — while `status` calls it healthy. Proven before this
      // check existed: reachable on the tunnel address.
      await using scratch = await scratchRepo(SERVES_EVERYWHERE);

      const refused = await scratch.devServer(scratch.root, "up");

      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("binding every interface");
      expect(await scratch.recordOrNull("main")).toBeNull();
    },
    CASE_MS,
  );

  test(
    "is a no-op while the server is answering",
    async () => {
      // The wrong implementation spawns anyway. The first child keeps the port,
      // the second cannot bind it, and the record now names a process that is not
      // the one serving — so `down` leaves a server running.
      await using scratch = await scratchRepo(SERVES);
      const started = await scratch.devServer(scratch.root, "up");
      const before = await scratch.record("main");

      const again = await scratch.devServer(scratch.root, "up");

      expect(again.code).toBe(0);
      expect(again.stdout).toBe(started.stdout);
      expect((await scratch.record("main")).pid).toBe(before.pid);
    },
    CASE_MS,
  );

  test(
    "comes back to the same port after a stop",
    async () => {
      // The wrong implementation probes for a free port every time. It works, and
      // it silently breaks the one property the derivation exists for: a
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
      killBehindItsBack(before.pid);
      expect(await settles(() => !running(before.pid))).toBe(true);

      const dead = await scratch.devServer(scratch.root, "status");
      const restarted = await scratch.devServer(scratch.root, "up");

      expect(dead.stdout).toContain("dead");
      expect(dead.stdout).toContain("silent");
      expect(restarted.code).toBe(0);
      const after = await scratch.record("main");
      expect(after.port).toBe(before.port);
      expect(after.pid).not.toBe(before.pid);
      expect(await answers(after.port)).toBe(true);
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
      killBehindItsBack(before.pid);
      expect(await settles(async () => !(await answers(before.port)))).toBe(true);

      using foreign = occupy(before.port);
      expect(foreign).toBeDefined();
      const refused = await scratch.devServer(scratch.root, "up");

      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(String(before.port));
      expect(refused.stderr).toContain("lsof");
      expect((await scratch.record("main")).port).toBe(before.port);
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
      const pending = scratch.devServer(scratch.root, "up");
      const started = await settled(async () => await scratch.recordOrNull("main"));

      const timedOut = await pending;

      expect(timedOut.code).toBe(1);
      expect(timedOut.stderr).toContain("did not answer");
      expect(timedOut.stderr).toContain("binding nothing");
      expect(await scratch.recordOrNull("main")).toBeNull();
      // And the child is gone, not merely unrecorded. Reading the log before
      // stopping it — the order this once had — leaves a server running whenever
      // that read fails, with nothing left that names it.
      expect(await settles(() => !running(started.pid))).toBe(true);
    },
    CASE_MS,
  );

  test(
    "reads the readiness timeout before it starts anything",
    async () => {
      // Parsed inside the wait, it was parsed after the spawn: an unreadable
      // value exited 1 having left a server running and recorded, which is the
      // one end state this tool exists to prevent.
      await using scratch = await scratchRepo(SERVES);
      const proc = Bun.spawn([process.execPath, "run", "dev-server", "up"], {
        cwd: scratch.root,
        env: { ...process.env, DEV_SERVER_READY_TIMEOUT_MS: "abc" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();

      expect(await proc.exited).toBe(1);
      expect(stderr).toContain("DEV_SERVER_READY_TIMEOUT_MS");
      expect(await scratch.recordOrNull("main")).toBeNull();
    },
    CASE_MS,
  );
});

describe("what a record is allowed to make this tool do", () => {
  test(
    "never signals a pid that is not the process it started",
    async () => {
      // The record is the input to a `kill` on a process GROUP. A pid is reused,
      // and a reboot recycles every one of them at once — so a record carried
      // across either names somebody else's processes, and `down` reported
      // success having killed them. The boot id and the start tick are what make
      // that answerable.
      await using scratch = await scratchRepo(SERVES);
      using innocent = await bystander();
      await scratch.devServer(scratch.root, "up");
      const server = await scratch.record("main");
      await scratch.putRecord(
        "main",
        JSON.stringify(
          { ...server, pid: innocent.pid, startTicks: server.startTicks + 1 },
          null,
          2,
        ),
      );

      const listed = await scratch.devServer(scratch.root, "status");
      const stopped = await scratch.devServer(scratch.root, "down");

      expect(listed.stdout).toContain("dead");
      expect(stopped.code).toBe(0);
      expect(stopped.stderr).toContain("already gone");
      expect(running(innocent.pid)).toBe(true);
      expect(await scratch.recordOrNull("main")).toBeNull();
      killBehindItsBack(server.pid);
    },
    CASE_MS,
  );

  test(
    "treats a record from another boot as naming nobody",
    async () => {
      // Every record on a machine survives its reboot, and every pid in one is
      // then somebody else's. Nothing about the file says so; the boot id does.
      await using scratch = await scratchRepo(SERVES);
      using innocent = await bystander();
      await scratch.devServer(scratch.root, "up");
      const server = await scratch.record("main");
      await scratch.putRecord(
        "main",
        JSON.stringify(
          { ...server, pid: innocent.pid, bootId: "00000000-0000-0000-0000-000000000000" },
          null,
          2,
        ),
      );

      const stopped = await scratch.devServer(scratch.root, "down");

      expect(stopped.stderr).toContain("already gone");
      expect(running(innocent.pid)).toBe(true);
      killBehindItsBack(server.pid);
    },
    CASE_MS,
  );

  test(
    "refuses a pid or a port no derivation of this tool could have produced",
    async () => {
      // `0` is the caller's own process group and `1` is every process the user
      // may signal; a decoder that only asked "is it a number" would hand either
      // to `kill`. A port outside the derived range did not come from here at all.
      await using scratch = await scratchRepo(SERVES);
      const template = {
        worktree: scratch.root,
        branch: "main",
        packageName: "x",
        port: 30_000,
        pid: 2,
        bootId: "b",
        startTicks: 1,
        log: scratch.paths("main").log,
        startedAt: new Date().toISOString(),
      };
      for (const broken of [
        { pid: 0 },
        { pid: 1 },
        { pid: -1 },
        { pid: 1.5 },
        { port: 80 },
        { port: 70_000 },
      ]) {
        await scratch.putRecord("main", JSON.stringify({ ...template, ...broken }, null, 2));

        const listed = await scratch.devServer(scratch.root, "status");

        expect(listed.stdout).toContain("junk");
        expect(listed.stdout).toContain("not the shape");
      }
      expect(running(process.pid)).toBe(true);
    },
    CASE_MS,
  );

  test(
    "does not let one unreadable record take every command down",
    async () => {
      // A record truncated by a crash made `status`, `up`, `down`, `url` and
      // `sweep` all exit 1 with "Failed to parse JSON" and no filename: the
      // repository's whole tool, wedged by one file, with no hint which.
      await using scratch = await scratchRepo(SERVES);
      const feature = await scratch.worktree("feature");
      await scratch.devServer(feature, "up");
      const alive = await scratch.record("feature");
      await scratch.putRecord("main", '{"worktree":"/half');

      const listed = await scratch.devServer(scratch.root, "status");
      const stopped = await scratch.devServer(scratch.root, "down");
      const missing = await scratch.devServer(scratch.root, "url");

      expect(listed.stdout).toContain(scratch.paths("main").record);
      expect(listed.stdout).toContain(String(alive.port));
      expect(stopped.code).toBe(0);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain(scratch.paths("main").record);

      const swept = await scratch.devServer(scratch.root, "sweep");

      expect(swept.code).toBe(0);
      expect(await Bun.file(scratch.paths("main").record).exists()).toBe(false);
      expect(await answers(alive.port)).toBe(true);
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
      // The wrong implementation reads the current worktree's record only — which
      // is exactly the state nobody can act on, because the server you have
      // forgotten about is the one in the worktree you are not standing in.
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
        expect(listed.stdout).toContain(String(server.port));
        expect(listed.stdout).toContain(String(server.pid));
      }
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
      // read is buried under another worktree's. That the log is keyed by
      // worktree at all is held by the record case above.
      await using scratch = await scratchRepo(SERVES);
      const feature = await scratch.worktree("feature");
      await scratch.devServer(scratch.root, "up");
      await scratch.devServer(feature, "up");

      const mine = await scratch.devServer(feature, "logs");

      const other = await scratch.record("feature");
      expect(mine.code).toBe(0);
      expect(mine.stdout).toContain(`fixture serving on 127.0.0.1:${other.port}`);
      expect(mine.stdout).not.toContain(`:${(await scratch.record("main")).port}`);
    },
    CASE_MS,
  );

  test(
    "keeps the log of a run that failed on its first line",
    async () => {
      // The wrong implementation truncates the log at `up`, before the child is
      // known to have started — so the run a person came to read about is
      // destroyed by the next attempt to reproduce it.
      await using scratch = await scratchRepo(NEVER_BINDS, 2000);
      await scratch.devServer(scratch.root, "up");

      await scratch.devServer(scratch.root, "up");
      const kept = await scratch.devServer(scratch.root, "logs");

      expect(kept.stdout.match(/started, binding nothing/g)).toHaveLength(2);
      expect(kept.stdout.match(/=== dev-server up /g)).toHaveLength(2);
    },
    CASE_MS,
  );

  test(
    "down stops the process, and says which of the two things it did",
    async () => {
      // The wrong implementation deletes the record and reports success while the
      // server goes on serving: the caller is told a thing happened that did not,
      // and the port stays held by a process nothing can find any more.
      await using scratch = await scratchRepo(SERVES);
      await scratch.devServer(scratch.root, "up");
      const server = await scratch.record("main");

      const stopped = await scratch.devServer(scratch.root, "down");
      const again = await scratch.devServer(scratch.root, "down");

      expect(stopped.code).toBe(0);
      expect(stopped.stderr).toContain("stopped");
      expect(again.code).toBe(0);
      expect(await settles(() => !running(server.pid))).toBe(true);
      expect(await answers(server.port)).toBe(false);
      expect(await scratch.recordOrNull("main")).toBeNull();
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
      const doomedLog = scratch.paths("feature").log;

      const removed = Bun.spawnSync(["git", "worktree", "remove", "--force", feature], {
        cwd: scratch.root,
      });
      expect(removed.exitCode).toBe(0);
      const swept = await scratch.devServer(scratch.root, "sweep");

      expect(swept.code).toBe(0);
      expect(swept.stderr).toContain(feature);
      expect(await settles(() => !running(doomed.pid))).toBe(true);
      expect(await scratch.recordOrNull("feature")).toBeNull();
      expect(await Bun.file(doomedLog).exists()).toBe(false);
      expect(running(kept.pid)).toBe(true);
      expect(await answers(kept.port)).toBe(true);
      expect(await scratch.recordOrNull("main")).not.toBeNull();
    },
    CASE_MS,
  );
});

describe("the argument list", () => {
  test(
    "refuses what a command does not take, rather than ignoring it",
    async () => {
      // The wrong implementation reads the flags it knows and drops the rest — so
      // `logs --folow` prints one tail and exits, and the person watching an empty
      // terminal concludes the follow is broken rather than misspelt.
      await using scratch = await scratchRepo(SERVES);

      const misspelt = await scratch.devServer(scratch.root, "logs", "--folow");
      const surplus = await scratch.devServer(scratch.root, "status", "--all");
      const unknown = await scratch.devServer(scratch.root, "restart");

      expect(misspelt.code).toBe(1);
      expect(misspelt.stderr).toContain("--folow");
      expect(surplus.code).toBe(1);
      expect(surplus.stderr).toContain("--all");
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("no such command");
    },
    CASE_MS,
  );

  test(
    "settles the arguments before it reads anything off the machine",
    async () => {
      // The wrong implementation asks git, reads a manifest and makes a directory
      // before it has looked at the command word — so outside a repository the
      // usage never prints, and a typo leaves a state directory behind.
      const outside = await mkdtemp(join(tmpdir(), "dev-server-nowhere-"));
      try {
        const proc = Bun.spawn(
          [process.execPath, "run", join(import.meta.dir, "..", "dev-server.ts"), "restart"],
          {
            cwd: outside,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const stderr = await new Response(proc.stderr).text();

        expect(await proc.exited).toBe(1);
        expect(stderr).toContain("no such command");
        expect(stderr).not.toContain("git ");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
    CASE_MS,
  );
});

describe("the fixture's own guards", () => {
  test("refuses to signal a pid that is not one", () => {
    // `killBehindItsBack(record?.pid ?? 0)` sent SIGKILL to the caller's own
    // process group: against an implementation that writes no record, this suite
    // killed `bun test` and reported nothing. A case reads a pid off a record
    // that has to be there, and these refuse the two numbers that are not pids.
    expect(() => killBehindItsBack(0)).toThrow("not a pid");
    expect(() => killBehindItsBack(1)).toThrow("not a pid");
    expect(() => running(0)).toThrow("not a pid");
  });
});

describe("the package", () => {
  test("ships the CLI and its derivation, and names only the CLI as a binary", async () => {
    // Two wrong implementations. A file omitted from `files` is not published and
    // one omitted from `bin` has no name for `bun run` to find. And a bin listed
    // in `exports` is a module this package tells consumers to import, which is
    // what README and CLAUDE.md say it is not.
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
    expect(parsed.files).toContain("dev-server-derive.ts");
    expect(parsed.bin).toEqual({ "dev-server": "./dev-server.ts" });
    expect(parsed.exports).not.toHaveProperty(["./dev-server.ts"]);
    expect(parsed.exports).not.toHaveProperty(["./dev-server-derive.ts"]);
  });
});
