import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Scheduler } from "effect";
import { join } from "node:path";

describe("loud when Effect changes", () => {
  const ROOT = join(import.meta.dir, "..");

  /**
   * What importing the export and running one `simulate` printed, in a
   * process of its own, since the self-check runs once per process, whose
   * `effect` is this repo's with `broken` laid over it: a JavaScript
   * expression over `real`, the real module, answering the module the
   * process gets instead. `version` stands in for effect's own, and `before`
   * runs before effect loads.
   */
  async function underBrokenEffect(
    broken: string,
    version = "4.1.4",
    before = "",
  ): Promise<string> {
    const script = [
      before,
      'import { plugin } from "bun";',
      `const real = await import(${JSON.stringify(Bun.resolveSync("effect", ROOT))});`,
      "plugin({",
      '  name: "broken effect",',
      "  setup(build) {",
      `    build.module("effect", () => ({ exports: ${broken}, loader: "object" }));`,
      `    build.module("effect/package.json", () => ({ exports: { default: { version: ${JSON.stringify(version)} }, version: ${JSON.stringify(version)} }, loader: "object" }));`,
      "  },",
      "});",
      "try {",
      `  const { simulate, unpreempted } = await import(${JSON.stringify(join(ROOT, "interleaving.ts"))});`,
      "  simulate(real.Effect.void, unpreempted);",
      '  console.log("ran");',
      "} catch (error) {",
      "  console.log(error.message);",
      "}",
    ].join("\n");
    const run = Bun.spawn(["bun", "--eval", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [said, status] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    expect(status).toBe(0);
    return said.trim();
  }

  /** A scheduler laid over the one `simulate` hands Effect, by a function over it, through `runForkWith`. */
  const overScheduler = (wrap: string) =>
    `{ ...real, Effect: { ...real.Effect, runForkWith: (context) => (effect, options) => real.Effect.runForkWith(context)(effect, { ...options, scheduler: (${wrap})(options.scheduler) }) } }`;

  // Kills a check that does not run, and one that passes on a broken runtime;
  // the first row is the control, which must run.
  test.each([
    ["nothing", "real", "ran"],
    [
      "a runtime that never switches fibers at the scheduler's word",
      overScheduler(
        '(inner) => ({ executionMode: "sync", makeDispatcher: () => inner.makeDispatcher(), shouldYield: (fiber) => { inner.shouldYield(fiber); return false; } })',
      ),
      "this process's effect no longer asks the scheduler between two steps joined by andThen",
    ],
    [
      "a map that runs its function as an op of its own",
      "{ ...real, Effect: { ...real.Effect, map: (...args) => args.length === 1 ? (self) => real.Effect.flatMap(self, (value) => real.Effect.sync(() => args[0](value))) : real.Effect.flatMap(args[0], (value) => real.Effect.sync(() => args[1](value))) } }",
      "this process's effect no longer runs two steps joined by map without asking the scheduler between them",
    ],
    [
      "a current fiber nobody can read",
      "{ ...real, Fiber: { ...real.Fiber, getCurrent: () => undefined } }",
      "this process's effect no longer asks with the fiber whose op comes next",
    ],
    [
      "a continuation queued only at the next question",
      overScheduler(
        '(inner) => { let told = false; let held; const deliver = () => { if (held) { const [dispatcher, task, priority] = held; held = undefined; dispatcher.scheduleTask(task, priority); } }; return { executionMode: "sync", shouldYield: (fiber) => { deliver(); told = inner.shouldYield(fiber); return told; }, makeDispatcher: () => { const dispatcher = inner.makeDispatcher(); return { scheduleTask: (task, priority) => { if (told) { told = false; held = [dispatcher, task, priority]; } else dispatcher.scheduleTask(task, priority); }, flush: () => dispatcher.flush() }; } }; }',
      ),
      "this process's effect no longer queues a fiber's continuation from that fiber, before asking anything else, when the scheduler tells it to yield",
    ],
    [
      "a run that drops the tracer it is handed",
      "{ ...real, Effect: { ...real.Effect, runForkWith: () => real.Effect.runForkWith(real.Context.empty()) } }",
      "this process's effect no longer hands the tracer's context hook every op of every fiber",
    ],
    [
      "a deferred completed on a timer",
      "{ ...real, Deferred: { ...real.Deferred, succeed: (deferred, value) => real.Effect.sync(() => { setTimeout(() => real.Deferred.doneUnsafe(deferred, real.Exit.succeed(value)), 0); return true; }) } }",
      "this process's effect no longer runs every slice after the root's first through the scheduler's dispatchers",
    ],
  ])("under %s, the first simulate says which fact failed", async (_name, broken, said) => {
    expect(await underBrokenEffect(broken)).toStartWith(said);
  });

  // Kills a self-check that passes where Effect cannot carry a forked fiber's
  // async context to its first op, which is what simulate tells the op where
  // Effect loses an interruption apart by.
  test("on a host where Effect finds no node:async_hooks, as Node before 20.16, the first simulate says so", async () => {
    expect(
      await underBrokenEffect(
        "real",
        "4.1.4",
        'const found = process.getBuiltinModule.bind(process); process.getBuiltinModule = (id) => (id === "node:async_hooks" || id === "async_hooks" ? undefined : found(id));',
      ),
    ).toStartWith(
      "this process's effect no longer runs a forked fiber's first op in the async context of the op that forked it",
    );
  });

  // Kills an export that loads on Effect 3, where its import links and every
  // fact it rests on fails, and one whose message does not say why.
  test("on Effect 3, importing the export says which Effect it found and which it needs", async () => {
    expect(await underBrokenEffect("real", "3.22.0")).toBe(
      "@gokayo43/dev-config/interleaving runs on effect 4, and this process's effect is 3.22.0: Effect 3 schedules fibers in a way simulate cannot drive",
    );
  });
});

describe("the interruption Effect 4.1.4 loses, outside simulate", () => {
  /**
   * The root forks a child and interrupts it before the child's first slice
   * runs, under a scheduler that runs every task from a queue of its own and
   * yields every fiber but the root at the first op of a slice. Answers
   * whether the root and the child ended once no task was left.
   */
  function interruptBeforeStart() {
    const queue: (() => void)[] = [];
    let root: Fiber.Fiber<unknown, unknown> | undefined;
    const scheduler: Scheduler.Scheduler = {
      executionMode: "sync",
      shouldYield: (fiber) => {
        root ??= fiber;
        return fiber !== root && fiber.currentOpCount === 1;
      },
      makeDispatcher: () => ({
        scheduleTask: (task) => void queue.push(task),
        flush: () => undefined,
      }),
    };
    let child: Fiber.Fiber<never> | undefined;
    const running = Effect.runFork(
      Effect.gen(function* () {
        child = yield* Effect.forkChild(Effect.never);
        yield* Fiber.interrupt(child);
      }),
      { scheduler },
    );
    for (let ran = 0; queue.length > 0 && ran < 100; ran++) queue.shift()?.();
    return {
      queued: queue.length,
      rootEnded: running.pollUnsafe() !== undefined,
      childEnded: child?.pollUnsafe() !== undefined,
    };
  }

  // simulate never preempts the op this case yields at, because Effect 4.1.4
  // loses the interruption there: the child's queued first slice runs its
  // program in the interruption's place, and the root waits on it forever.
  // The day an Effect release fixes that, this case fails, and says the
  // exclusion in interleaving.ts can go; dev-config#210 tracks it.
  test("an interruption of a fiber yielded at its first op before it started is lost", () => {
    expect(interruptBeforeStart()).toEqual({ queued: 0, rootEnded: false, childEnded: false });
  });
});
