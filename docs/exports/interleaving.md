# Generated interleavings

`@gokayo43/dev-config/interleaving` lets a property test in an Effect codebase
generate the order in which overlapping fibers' steps run. A race nobody wrote
a case for is found by the search, and the seed fast-check prints replays it.

```ts
import { interleavingsOf, simulate } from "@gokayo43/dev-config/interleaving";
import { check } from "@gokayo43/dev-config/property";
import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { property } from "fast-check";

import { makeSeats } from "../src/seats.ts";

const bookTwice = Effect.gen(function* () {
  const seats = yield* makeSeats(1);
  const first = yield* Effect.forkChild(seats.book);
  const second = yield* Effect.forkChild(seats.book);
  return [yield* Fiber.join(first), yield* Fiber.join(second)].filter(Boolean).length;
});

test("two bookings of the last seat sell it once", () => {
  check(
    property(interleavingsOf(bookTwice), (interleaving) => {
      expect(simulate(bookTwice, interleaving)).toMatchObject({
        parked: false,
        exit: Exit.succeed(1),
      });
    }),
    { numRuns: 1_000 },
  );
});
```

- `simulate(program, interleaving)` runs the program until no fiber can run,
  synchronously, and answers `{ parked: false, exit, ops }` for a run that
  finished, or `{ parked: true, ops, stranded }` for a run in which every fiber
  was waiting with the program unfinished. A deadlock is a parked run. `ops` is
  how many ops the run executed up to that point.
- `interleavings(ops)` is the fast-check arbitrary of interleavings for a
  program whose run takes `ops` ops when nothing preempts it.
  `interleavingsOf(program)` is that arbitrary sized to the program's own run
  under `unpreempted`, the interleaving that preempts nothing and runs tasks
  first in first out. Sizing it, and `numRuns`, is below. An interleaving is
  plain data, so fast-check prints it in a counterexample and shrinks it like
  any other value, and a test can write one by hand.
- Before it answers, `simulate` interrupts every fiber of the run still
  unfinished, detached ones included, and lets them wind down, so finalizers
  run and nothing of the run outlives the call. The one exception is a fiber
  that interruption cannot reach, below.
- `simulate` throws when the run does not finish within 100 000 ops, and when a
  run that finished leaves a fiber interruption cannot end. A program that needs
  more ops passes `{ maxOps }` as a third argument, to `simulate` and to
  `interleavingsOf` alike.

The program is built fresh for each run: state the fibers share is created
inside the effect, as `makeSeats` does above, never outside it. `effect` is an
optional peer dependency, 4.1.4 or later below 5, and the repo brings its own
beside `fast-check`. On any other major version, importing the export throws,
naming the version it found: on Effect 3 it reads
`@gokayo43/dev-config/interleaving runs on effect 4, and this process's effect is 3.22.0`,
followed by why.

## How it works

Effect 4's run loop asks its `Scheduler`, through `shouldYield`, at every step
whether the running fiber should yield there, and every resumed, forked or
yielded fiber is a task handed to one of that scheduler's dispatchers.
`simulate` installs a scheduler whose every answer comes from the
interleaving: it says at each step whether to preempt, and it picks which
queued task runs next. No timer, no microtask and no clock decides the order,
so the same program under the same interleaving executes the same order every
time. Like Effect's own scheduler, it also yields a fiber that has run
`Scheduler.MaxOpsBeforeYield` ops in one slice, 2 048 unless the program sets
it, so a fiber that busy-polls for another still lets it run.

An op is one step of that loop. A preemption can fall wherever Effect's runtime
can switch fibers and nowhere else, except at the one step where Effect 4.1.4
loses an interruption, which "What a program may contain" describes. That is
between any two steps of one fiber, two synchronous ones included, and inside an
`Effect.uninterruptible` region, which stops interruption but not scheduling.
That is the reach fast-check's own `fc.scheduler` lacks: it reorders only at the
promises a test wraps, and in the prototype this export came from
(dev-config#140) it found none of the four subtle bugs planted there.

Effect 4 runs more inside one step than Effect 3 did. A step that succeeds
hands its value straight to the next continuation, up to 32 at a time, without
returning to the loop, so the runtime never switches fibers inside such a
chain, and neither does `simulate`. Two steps joined by `Effect.map` are one
op, and no interleaving runs another fiber between them; two joined by
`Effect.andThen`, or written as two `yield*` in `Effect.gen`, are two, and a
preemption can fall between them:

```ts
// One op: nothing can run between the read and the write.
Effect.sync(() => hits).pipe(Effect.map((seen) => (hits = seen + 1)));

// Two ops: a preemption between them loses an update.
Effect.gen(function* () {
  const seen = yield* Effect.sync(() => hits);
  yield* Effect.sync(() => (hits = seen + 1));
});
```

Under `Scheduler.PreventSchedulerYield` the runtime asks the scheduler nothing,
so it switches fibers in such a region only where a fiber waits, and so does
`simulate`.

Effect orders the tasks of one dispatcher: a lower priority number first, and
first in first out among equals. Each fiber has a dispatcher of its own, and a
task goes on the dispatcher of the fiber that queued it: a fork's first slice on
its parent's, a lock handed to a waiter on the releasing fiber's, a fiber's own
continuation on its own. Tasks on different dispatchers are unordered, and
`simulate` picks among the one task each dispatcher would run next, so it never
runs a task ahead of one Effect guarantees runs first. The forks of one parent
therefore start in the order they were forked, and a pick reorders them only
once a preemption at each child's first step has moved its continuation to the
child's own dispatcher.

A fiber Effect resumes after a preemption runs the step it was stopped before
without asking again, so a preemption adds no op to a run.

Everything rests on six things Effect 4.1.4's runtime does: it asks the
scheduler between two steps joined by `andThen`; it runs two steps joined by
`map` without asking; it asks with the fiber whose step comes next, at op count
1 on the first step of a slice, and makes the fiber that queues a task the
current one, so a fork's first step is its child's and a yield's first step is
the yielder's; it queues a fiber's continuation from that fiber, before asking
anything else, when the scheduler tells it to yield; it hands a tracer's
`context` hook every step of every fiber, those under `PreventSchedulerYield`
included, which is how the wind-down finds a run's fibers; and it runs every
slice after the root's first through the scheduler's dispatchers. The first
`simulate` in a process runs small programs that check each, and throws naming
the one that failed. So a repo whose Effect stopped doing any of them fails its
race properties loudly, instead of passing them by finding nothing, ranking the
wrong fiber, or leaving each run's fibers alive.

`simulate` provides the run's tracer, which hands spans to Effect's own. A
tracer the program provides replaces it in the fiber's context, and with it
would go the hook. So the step that provides it is followed by `simulate`
putting it back behind a hook of its own: the program's tracer still makes
every span and still sees every step through its own `context`, and the
fibers under it are still wound down.

The arbitrary mixes two strategies, because the prototype needed both to find
its races:

- a random walk, which preempts at up to 60 generated op indices and then picks
  the next task from generated choices. A pick is an index taken modulo the
  number of tasks Effect allows next, so it reaches every one of them.
- a priority strategy, PCT (Burckhardt et al., ASPLOS 2010), which gives each
  fiber a generated priority, always runs the highest, and drops a fiber below
  every other when it yields of its own accord and at up to three generated op
  indices. A queued task does not say which fiber it runs, so the strategy runs
  every such task first: nothing of the program runs before the runtime asks
  about the task's fiber at its first step, where it is ranked and, when
  outranked, told to yield. A fiber yields of its own accord when the first
  step of a task it queued itself is its own. A fiber started by `Effect.all`
  or `Effect.forEach` keeps the priority it is given, and a fiber that hands
  work to others keeps its own: releasing a lock to the fibers waiting on it,
  or opening a latch, is not a yield. A fiber the runtime resumes inside
  another's step, as completing a `Deferred` resumes its waiters, runs there
  only when it outranks every fiber in the middle of a step beneath it. Up to
  24 priorities are generated, so fibers the run meets after the 24th all get 0.

## What a program may contain

Only its own fibers. A fiber waiting on anything outside the program waits on
something no interleaving controls, so at the end of the run it looks parked,
and the property reads a deadlock that is not there. A real timer waits that
way: `Effect.sleep` on the live clock, and the timer behind a timeout, which
never fires inside a run. So does real I/O: a database driver and `fetch`. So
does every promise, including one that is already resolved, because a promise
settles on a microtask and the run has ended by then. An in-memory fake written
as an `async` function parks the run just as a real call would. Put each behind
a service the test replaces with an in-memory one written in Effect, completing
through a `Deferred` or a `Ref`.

`TestClock` runs inside a run. Effect 4's `TestClock.adjust` wakes each sleep it
passes through the scheduler and waits for the fibers it woke through the
scheduler too, so code that sleeps or times out is driven by it here. An adjust
that runs before a sleep is registered wakes nothing, and the search finds that
order, in which the sleeper parks.

Effect 4.1.4 loses an interruption in one order. A fiber is interrupted from
another fiber's step before its own first slice has run, so Effect runs the
interruption there and then, and the scheduler tells the fiber to yield at the
interruption's first step. The fiber's first slice, still queued, then runs the
fiber's own program in the interruption's place, and whoever waits for the
fiber to end waits forever. Effect's default scheduler does not reach that
order at any `Scheduler.MaxOpsBeforeYield`, 1 included, so a park there is
Effect's bug and never the program's. `simulate` therefore never preempts that
one step, and that is the one exception to its reach: a preemption falls at
every point where the runtime can switch fibers except the first step of an
interruption of a fiber the run has not yet seen start. It tells that step
apart by the async context Effect gives a forked fiber, which keeps the context
of the step that forked it; a fiber forked to start at once runs in its
parent's step instead, and its first step can still be preempted. `TestClock`
used to meet the order: each sleep starts a fiber that warns when the clock is
never adjusted, an adjust interrupts that fiber, and a program on `TestClock`
with no race of its own parked in 33 of 20 000 interleavings. This repo's suite
holds the bug itself on a scheduler of its own, outside `simulate`, and that
case fails once a release no longer loses the interruption, which is when the
exception goes.

For the run's duration `simulate` replaces `Math.random` with Effect's
generator seeded by the interleaving's values, then puts it back, on a throw
too. Effect's default `Random` service draws from `Math.random`, so a program
on its default `Random` draws the same numbers on every run of one
interleaving. The same interleaving draws the same numbers however its fields
are written, and an interleaving fast-check shrinks draws others. That covers
Effect's hashing of plain objects, which draws from `Math.random`, so a
`HashSet` or `HashMap` keyed by them iterates in the same order on every run of
one interleaving. A program that reaches past these for anything that differs
between runs is not replayable: the clock, a `Random` it provides itself with
another seed, and anything the process keeps across runs, such as fiber ids,
which count up for the life of the process.

Whatever a waiting fiber was waiting on is let go when the run winds down: the
wait is interrupted, so a timer is cleared, and a promise that settles later
wakes nothing. A wait that interruption cannot reach is not let go: one inside
an uninterruptible region, such as the acquire of `Effect.acquireRelease`, or a
finalizer that never completes. The parked verdict counts such fibers in
`stranded`. Effect 4 keeps no global set of running fibers, so once `simulate`
lets go of its own state for the run, its queue, the run's fibers and the
strategy's ranks, a stranded fiber is held only by what it waits on, and goes
with it. Measured on this repo's lock-order inversion on
`Effect.acquireRelease`, which strands three fibers a run, the heap stood at
6.0 MB before 3 580 parks and at 6.5 MB after them and after 14 320 more, on
Bun 1.4.4 and Effect 4.1.4.

## Sizing `ops` and the run count

`ops` decides where the generated preemptions fall: the walk's preemption points
and the priority strategy's change points are drawn below it. Size it to the
program's run under `unpreempted`, which is what `interleavingsOf(program)`
does. That count stops where the run finished or parked: the wind-down's ops
are not in it, since no interleaving schedules them. A preemption adds no op,
but a different order can take a different path through the code, so a run
under a generated interleaving can be longer or shorter. When the program is
built from generated operations,
size `ops` from the largest program the generator produces, and generate both:

```ts
check(
  property(operations, interleavings(400), (steps, interleaving) => {
    expect(simulate(scenario(steps), interleaving)).toMatchObject({ parked: false });
  }),
  { numRuns: 700 },
);
```

The run count goes through [`check`](property.md), like every other property,
so the nightly multiplies whatever the property states. What the property states
is its own `numRuns`, sized from the share of generated interleavings that fail
against the racy version, `p`: at least `ln(10⁶) / p`, about 13.8 / p, which
misses the race in fewer than one search in a million. Measure `p` by running
the property against the racy version over many runs on one seed, counting the
failing runs rather than stopping at the first.

This repo's own fixtures, each sized by the rule above, measured as follows by
`bun tests/interleaving-measure.ts`, which re-takes the table, on Effect 4.1.4.
The share is the failing runs among 20 000 generated on seed 1. The runs to find
are the `numRuns` at which `fc.check` with `endOnFailure` failed, on each of
seeds 1 to 20, capped at 3 000; every seed found every race.

| Fixture                                     | `ops` | Strategy | Share failing | Median runs to find | Slowest of 20 seeds |
| ------------------------------------------- | ----- | -------- | ------------- | ------------------- | ------------------- |
| a check-then-act across a yield             | 34    | walk     | 23%           | 3.5                 | 13                  |
|                                             |       | priority | 31%           | 3                   | 10                  |
|                                             |       | mixed    | 27%           | 2                   | 21                  |
| a lost update between two synchronous steps | 20    | walk     | 13%           | 11                  | 46                  |
|                                             |       | priority | 5.9%          | 25                  | 43                  |
|                                             |       | mixed    | 9.5%          | 8.5                 | 32                  |
| a torn read across a whole write            | 23    | walk     | 1.2%          | 49.5                | 256                 |
|                                             |       | priority | 1.0%          | 67                  | 395                 |
|                                             |       | mixed    | 1.2%          | 50.5                | 375                 |

The suite searches each with the mixed arbitrary, over 1 200 runs, the torn
read's count by the rule above.

## Judging an overlapped run

An invariant on the final state alone misses a run whose callers were told
something no correct order could have told them. Judge the run as a whole:
each operation records when it started, when it ended and what it answered,
and the run passes when some serial order of the operations, one that keeps
each operation after every operation that had ended before it started, gives
each its answer and ends in the state the run ended in.

The program records the times on a clock it ticks itself, in the op that starts
the operation and in the op that ends it, so the times are the order the run
executed. This repo's booking fixture, two bookings of the last seat:

```ts
interface Call<A> {
  readonly start: number;
  readonly end: number;
  readonly answer: A;
}

const call = Effect.gen(function* () {
  const start = clock++;
  const answer = yield* attempt; // true when this booking sold the seat
  calls.push({ start, end: clock++, answer });
});
```

The judge tries every order the start and end times allow, applying a model of
one operation, run alone, to the state:

```ts
const book = (left: number): readonly [boolean, number] =>
  left > 0 ? [true, left - 1] : [false, left];

function serial<S, A>(
  calls: readonly Call<A>[],
  state: S,
  apply: (state: S) => readonly [A, S],
  final: S,
): boolean {
  if (calls.length === 0) return state === final;
  return calls.some((call) => {
    if (calls.some((other) => other.end < call.start)) return false;
    const [answer, next] = apply(state);
    return (
      answer === call.answer &&
      serial(
        calls.filter((other) => other !== call),
        next,
        apply,
        final,
      )
    );
  });
}

expect(serial(calls, 1, book, left)).toBe(true);
```

A run in which both bookings answered `true` and no seat is left fails: in
either order the second booking, applied to 0 seats, answers `false`. A run in
which one answered `true`, the other `false`, and no seat is left passes. Where
the operations differ, each call carries the model of its own operation, and
the judge applies that one. `tests/interleaving-fixtures.ts` holds the fixture
and the judge as the suite runs them.

## Turning a race the search found into a regression case

Do not pin the seed or the interleaving a failure printed. Both are decisions
about op indices and queue positions. A change to the code's shape moves those,
and the pinned interleaving then runs some other order, which passes without
testing anything. Nor is a sweep of hand-written interleavings a regression
case: one preemption at each op misses every race that needs two, such as the
torn read below.

The regression case is a failure-mode probe: the race's own order, driven by a
latch at a seam in the code under test
(`~/claude-shared/references/failure-modes.md`). The counterexample says where
the latch goes.

1. Replay the counterexample's interleaving with `simulate`, on a program that
   records each step it takes in the same synchronous op as the step. A log
   written by an op of its own can be preempted away from the step it records,
   and then shows an order that did not happen.
2. Read the log for operations that were cut: one whose steps have another
   operation's steps between them. Each cut is a latch position, in the cut
   operation's code at the point it was cut. The steps in the gap are what the
   probe runs while the cut operation is held. An operation the gap holds only
   part of was cut too, and gets a latch of its own.
3. Give the code a seam at each latch position: an effect it runs there, which
   is `Effect.void` in production and which the probe replaces.
4. In the probe, hold each cut operation at its seam, fork the gap's
   operations, let Effect's runtime run them with `Effect.yieldNow`, read where
   each stood, let the held ones go in the log's order, and judge the result as
   the property does.

Effect 4 has no `Fiber.status`, so the probe reads where a fiber stood from the
two things its `Fiber` says: `pollUnsafe()` answers its exit once it has
finished, and `currentOpCount` is 0 until its first step. A forked operation
that has an exit finished; one that has taken a step and has no exit is
waiting; one at 0 never started, and the probe then proves nothing about the
race. A parent's forks start on the parent's dispatcher in the next scheduler
turn, so one `Effect.yieldNow` in the probe runs each gap operation until it
finishes or waits, as long as it does not yield of its own accord. One that does
needs one more `Effect.yieldNow` per yield it takes.

This repo's torn read is a ledger whose deposit credits the balance and then
appends the entry, and whose reading reads the balance and then the entries. A
reading must never see an entry the balance does not pay for. That invariant is
narrower than judging the run by a serial order, as the section above does: it
accepts a reading of the balance credited and the entry not yet appended, which
no serial order explains. The fixture narrows it on purpose, so that the race
left needs two preemptions, the kind a one-preemption sweep misses. The search finds
the race, and the counterexample's log is `read balance`, `credit`, `append`,
`read entries`: the reading was cut between its two reads, and a whole deposit
ran in the gap. One latch, between the reading's two reads:

```ts
const stood = (fiber: Fiber.Fiber<unknown, unknown>): "finished" | "waiting" | "not started" =>
  fiber.pollUnsafe() !== undefined
    ? "finished"
    : fiber.currentOpCount > 0
      ? "waiting"
      : "not started";

const probe = (locked: boolean) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const ledger = yield* makeLedger(
      locked,
      Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const reading = yield* Effect.forkChild(ledger.read);
    yield* Deferred.await(reached);
    const deposit = yield* Effect.forkChild(ledger.deposit);
    yield* Effect.yieldNow;
    const depositStood = stood(deposit);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(deposit);
    return { read: yield* Fiber.join(reading), depositStood };
  });

test("the probe drives the torn read: a whole deposit between the reading's reads", async () => {
  const { read, depositStood } = await Effect.runPromise(probe(false));
  expect(depositStood).toBe("finished");
  expect(covered(read)).toBe(false);
});

test("the probe holds the locked ledger, with the deposit waiting on the reading", async () => {
  const { read, depositStood } = await Effect.runPromise(probe(true));
  expect(depositStood).toBe("waiting");
  expect(covered(read)).toBe(true);
});
```

`covered` is the invariant: no more entries than the balance pays for. This
repo keeps both versions of the ledger, so its suite asserts that the probe
catches the racy one and passes the locked one. A repo with one ledger keeps the
second test's assertions, which fail until the race is fixed.

The probe runs on Effect's own runtime, not under `simulate`: the latch decides
the order, and nothing else can change it. Against the racy ledger the deposit
finishes while the reading is held, and the reading sees an entry with no
balance behind it. Against a ledger whose deposit and reading take one lock,
the deposit is waiting on the lock when the reading is let go, and the reading
sees neither. `depositStood` says which: either way the deposit was in flight
while the reading was held, and asserting where it stood proves the probe
reached the race rather than passing beside it. Without the `Effect.yieldNow`
the deposit has not started when the reading is let go, both cases read
`not started`, and both tests fail. This repo's suite holds both cases as
written here.

The property stays beside the probe. It is what finds the race's siblings.

## Reading a counterexample

This applies to a program built from generated operations. The op indices in an
interleaving count every op the run executes, across all its fibers. When
fast-check shrinks the operations, removing one shifts the index of every op
after it, so the same interleaving no longer preempts at the same place and the
race disappears. Shrinking therefore keeps operations that do not take part in
the race. Expect a counterexample with more operations than the race needs, and
read the program's log to see which of them matter.
