/**
 * The lock, with every waiter stopped before each step of taking it and run one
 * step at a time by the case, so each interleaving below is the one the case
 * names rather than one the scheduler happened to pick. Waiters in this process
 * share its pid, which the lock reads as alive; a holder that is gone is a
 * holder text naming another boot, or this pid with another start tick.
 */
import { describe, expect, test } from "bun:test";
import { link, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { array, asyncProperty, constantFrom, integer, nat } from "fast-check";

import { bootId, lock, procStat } from "../file-lock.ts";
import { check } from "../property.ts";

/** More waiting than any schedule here asks for, since waiting costs no time under one. */
const PATIENT = 1_000_000_000;

/** A schedule this long without every waiter finishing is a livelock. */
const STEPS = 5_000;

const CHILD = join(import.meta.dir, "file-lock-child.ts");

/** What a holder writes, for a holder that is this process. */
async function aliveText(): Promise<string> {
  const mine = await procStat(process.pid);
  if (mine === null) throw new Error("this process has no /proc entry");
  return `${JSON.stringify({ pid: process.pid, bootId: await bootId(), startTicks: mine.startTicks })}\n`;
}

/** What a holder that is gone left in its lock: by each of the two ways a holder can be gone, or not a holder at all. */
async function deadText(how: "another boot" | "a reused pid" | "junk"): Promise<string> {
  const mine = await procStat(process.pid);
  if (mine === null) throw new Error("this process has no /proc entry");
  if (how === "junk") return "not a holder";
  return `${JSON.stringify({
    pid: process.pid,
    bootId: how === "another boot" ? "the boot before this one" : await bootId(),
    startTicks: how === "a reused pid" ? mine.startTicks + 1 : mine.startTicks,
  })}\n`;
}

interface Stop {
  readonly next: string;
  readonly path: string;
  readonly go: () => void;
}

interface Worker {
  /** Where it is stopped, while it is. */
  at: Stop | undefined;
  holding: boolean;
  finished: boolean;
  failure: unknown;
}

/**
 * A directory holding a lock and a counter, and the waiters that take the lock
 * to add one to the counter, each stopped before every step until the case
 * runs it.
 */
async function arena(): Promise<{
  readonly path: string;
  readonly lockPath: string;
  readonly workers: Worker[];
  readonly overlaps: () => number;
  start(patienceMs?: number): Promise<Worker>;
  step(worker: Worker): Promise<void>;
  until(worker: Worker, reached: (at: Stop | undefined, worker: Worker) => boolean): Promise<void>;
  counted(): Promise<number>;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), "file-lock-"));
  const lockPath = join(path, "ceilings.lock");
  const counter = join(path, "counter");
  await writeFile(counter, "0");
  const workers: Worker[] = [];
  let overlaps = 0;
  let moving = 0;
  let wake = (): void => {};
  const stopped = (): void => {
    moving -= 1;
    if (moving === 0) wake();
  };
  const settled = async (): Promise<void> => {
    if (moving === 0) return;
    await new Promise<void>((done) => {
      wake = done;
    });
  };
  const step = async (worker: Worker): Promise<void> => {
    const at = worker.at;
    if (at === undefined) throw new Error("the worker is not stopped at a step");
    worker.at = undefined;
    moving += 1;
    at.go();
    await settled();
  };
  return {
    path,
    lockPath,
    workers,
    overlaps: () => overlaps,
    async start(patienceMs = PATIENT): Promise<Worker> {
      const worker: Worker = { at: undefined, holding: false, finished: false, failure: undefined };
      const pause = async (next: string, at: string): Promise<void> => {
        await new Promise<void>((go) => {
          worker.at = { next, path: at, go };
          stopped();
        });
      };
      workers.push(worker);
      moving += 1;
      void (async (): Promise<void> => {
        const held = await lock(lockPath, patienceMs, pause);
        if (workers.some((other) => other.holding)) overlaps += 1;
        worker.holding = true;
        const seen = Number(await readFile(counter, "utf8"));
        await pause("inside", lockPath);
        await writeFile(counter, String(seen + 1));
        worker.holding = false;
        await held[Symbol.asyncDispose]();
      })()
        .catch((error: unknown) => {
          worker.failure = error;
        })
        .finally(() => {
          worker.finished = true;
          stopped();
        });
      await settled();
      return worker;
    },
    step,
    async until(worker, reached): Promise<void> {
      while (!reached(worker.at, worker)) {
        if (worker.finished) throw new Error("the worker finished before it reached the step");
        await step(worker);
      }
    },
    counted: async () => Number(await readFile(counter, "utf8")),
    async [Symbol.asyncDispose](): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Steps every stopped worker in turn until none is left stopped. */
async function finish(ground: Awaited<ReturnType<typeof arena>>): Promise<void> {
  for (let turn = 0; ; turn++) {
    const stopped = ground.workers.filter((worker) => worker.at !== undefined);
    if (stopped.length === 0) return;
    if (turn > STEPS) throw new Error("the workers did not finish: a livelock");
    const next = stopped[turn % stopped.length];
    if (next !== undefined) await ground.step(next);
  }
}

/** Whether a worker is stopped before `next` on the lock itself, rather than on a claim beside it. */
const atMain =
  (ground: { readonly lockPath: string }, next: string) =>
  (at: Stop | undefined): boolean =>
    at?.next === next && at.path === ground.lockPath;

describe("two waiters at one dead holder's lock", () => {
  test("the second does not take the lock the first took over", async () => {
    // The wrong implementation removes the lock once it has judged its holder
    // gone. Both judge the same dead holder gone; the first removes its lock and
    // links its own, and the second then removes the first's live one.
    await using ground = await arena();
    await writeFile(ground.lockPath, await deadText("another boot"));
    const first = await ground.start();
    const second = await ground.start();
    await ground.until(first, atMain(ground, "take"));
    await ground.until(second, atMain(ground, "take"));

    await ground.until(first, (_, worker) => worker.holding);
    await ground.until(second, (at, worker) => worker.holding || atMain(ground, "wait")(at));

    expect(ground.overlaps()).toBe(0);
    expect(second.holding).toBe(false);
    await finish(ground);
    expect(await ground.counted()).toBe(2);
  });

  test("a third cannot get in while the second puts back what it moved", async () => {
    // The wrong implementation moves the dead lock aside and checks what it
    // moved, with nothing to keep a waiter that judged the holder gone from
    // moving a lock somebody alive took over since: it then puts the live lock
    // back, and between the move and the putting back a third links its own.
    await using ground = await arena();
    await writeFile(ground.lockPath, await deadText("a reused pid"));
    const first = await ground.start();
    const second = await ground.start();
    await ground.until(first, atMain(ground, "take"));
    await ground.until(second, atMain(ground, "take"));
    await ground.until(first, (_, worker) => worker.holding);
    await ground.until(
      second,
      (at, worker) => worker.holding || atMain(ground, "wait")(at) || atMain(ground, "confirm")(at),
    );

    const third = await ground.start();
    await ground.until(third, (at, worker) => worker.holding || atMain(ground, "wait")(at));

    expect(ground.overlaps()).toBe(0);
    await finish(ground);
    expect(await ground.counted()).toBe(3);
  });
});

describe("a waiter whose read finds the lock gone", () => {
  test("links again rather than removing what a third linked meanwhile", async () => {
    // The wrong implementation reads a lock that is not there as abandoned and
    // removes the lock path: the holder released between the waiter's failed
    // link and its read, a third linked, and the waiter removes the third's lock.
    await using ground = await arena();
    const first = await ground.start();
    await ground.until(first, (_, worker) => worker.holding);
    const second = await ground.start();
    await ground.until(second, atMain(ground, "read"));
    await ground.until(first, (_, worker) => worker.finished);
    await ground.step(second);

    const third = await ground.start();
    await ground.until(third, (_, worker) => worker.holding);
    await ground.until(second, (at, worker) => worker.holding || atMain(ground, "wait")(at));

    expect(ground.overlaps()).toBe(0);
    expect(second.holding).toBe(false);
    await finish(ground);
    expect(await ground.counted()).toBe(3);
  });
});

describe("a lock replaced by hand while it is taken over", () => {
  test("puts back a live holder's lock it moved aside", async () => {
    // The wrong implementation discards whatever it moved, so a lock a person
    // removed and another run took between the recheck and the move is gone.
    await using ground = await arena();
    await writeFile(ground.lockPath, await deadText("another boot"));
    const waiter = await ground.start();
    await ground.until(waiter, atMain(ground, "move"));
    await rm(ground.lockPath);
    const someone = join(ground.path, "someone");
    await writeFile(someone, await aliveText());
    await link(someone, ground.lockPath);

    await ground.until(waiter, atMain(ground, "wait"));

    expect((await stat(ground.lockPath)).ino).toBe((await stat(someone)).ino);
    await rm(ground.lockPath);
    await finish(ground);
    expect(await ground.counted()).toBe(1);
  });

  test("fails loudly when a second process took the lock before it could be put back", async () => {
    await using ground = await arena();
    await writeFile(ground.lockPath, await deadText("another boot"));
    const waiter = await ground.start();
    await ground.until(waiter, atMain(ground, "move"));
    await rm(ground.lockPath);
    const replaced = join(ground.path, "replaced");
    await writeFile(replaced, await aliveText());
    await link(replaced, ground.lockPath);
    await ground.step(waiter);
    const second = join(ground.path, "second");
    await writeFile(second, await aliveText());
    await link(second, ground.lockPath);

    await finish(ground);

    expect(String(waiter.failure)).toContain("two processes may each believe they hold it");
  });
});

test("gives up on a live holder after its patience, naming it", async () => {
  await using ground = await arena();
  await writeFile(ground.lockPath, await aliveText());
  const waiter = await ground.start(100);

  await finish(ground);

  expect(String(waiter.failure)).toContain(
    `has been held for 100ms by process ${process.pid}, which is still running`,
  );
});

describe("a worker killed while taking the lock", () => {
  test.each([
    ["link", "none"],
    ["read", "alive"],
    ["wait", "alive"],
    ["take", "dead"],
    ["recheck", "dead"],
    ["move", "dead"],
    ["confirm", "dead"],
    ["held", "none"],
  ] as const)(
    "before %s, costs the next one nothing and leaves nothing beside the lock",
    async (stop, before) => {
      // The wrong implementations leave what the killed worker wrote: its
      // holder file, a claim it held, a dead lock moved aside, or a lock only a
      // person can remove.
      await using ground = await arena();
      const live = before === "alive" ? await lock(ground.lockPath, 1_000) : null;
      if (before === "dead") await writeFile(ground.lockPath, await deadText("another boot"));
      const child = Bun.spawn([process.execPath, CHILD, ground.lockPath, stop], {
        stdout: "pipe",
        stderr: "inherit",
      });
      try {
        const reader = child.stdout.getReader();
        const { value } = await reader.read();
        expect(new TextDecoder().decode(value)).toBe("at\n");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
      await live?.[Symbol.asyncDispose]();

      const next = await lock(ground.lockPath, 1_000);
      await next[Symbol.asyncDispose]();

      expect((await readdir(ground.path)).toSorted()).toEqual(["counter"]);
    },
    10_000,
  );
});

test("no two waiters hold it at once, whatever order their steps run in", async () => {
  // The invariant every interleaving keeps: at most one holder at a time, every
  // waiter told it holds the lock exactly once, each increment kept, and
  // nothing left beside the lock once all are done.
  await check(
    asyncProperty(
      integer({ min: 2, max: 4 }),
      constantFrom("none", "another boot", "a reused pid", "junk"),
      array(nat(), { maxLength: 80 }),
      async (count, before, picks) => {
        await using ground = await arena();
        if (before !== "none") await writeFile(ground.lockPath, await deadText(before));
        for (let each = 0; each < count; each++) await ground.start();

        for (let turn = 0; ; turn++) {
          const stopped = ground.workers.filter((worker) => worker.at !== undefined);
          if (stopped.length === 0) break;
          expect(turn).toBeLessThan(STEPS);
          const next = stopped[(picks[turn] ?? turn) % stopped.length];
          if (next !== undefined) await ground.step(next);
          expect(ground.overlaps()).toBe(0);
        }

        expect(ground.workers.map((worker) => worker.failure)).toEqual(
          ground.workers.map(() => undefined),
        );
        expect(await ground.counted()).toBe(count);
        expect((await readdir(ground.path)).toSorted()).toEqual(["counter"]);
      },
    ),
  );
}, 60_000);
