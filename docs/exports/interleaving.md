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
  const first = yield* Effect.fork(seats.book);
  const second = yield* Effect.fork(seats.book);
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
  under `unpreempted`, the interleaving that preempts nothing and runs fibers
  first in first out. Sizing it, and `numRuns`, is below. An interleaving is
  plain data, so fast-check prints it in a counterexample and shrinks it like
  any other value, and a test can write one by hand.
- Before it answers, `simulate` interrupts every fiber of the run still
  unfinished, daemons included, and lets them wind down, so finalizers run and
  nothing of the run outlives the call. The one exception is a fiber that
  interruption cannot reach, below.
- `simulate` throws when the run does not finish within 100 000 ops, and when a
  run that finished leaves a fiber interruption cannot end. A program that needs
  more ops passes `{ maxOps }` as a third argument, to `simulate` and to
  `interleavingsOf` alike.

The program is built fresh for each run: state the fibers share is created
inside the effect, as `makeSeats` does above, never outside it. `effect` is an
optional peer dependency, 3.22 or later below 4, and the repo brings its own
beside `fast-check`. Effect 4.0.0, published on 2026-10-01, is outside that
range: a repo on Effect 4 does not have this export.

## How it works

Effect's runtime asks its `Scheduler` before every op of every fiber whether
the fiber should yield there, and every resumed, forked or yielded fiber is a
task handed to that same scheduler. `simulate` installs one whose every answer
comes from the interleaving: it says before each op whether to preempt, and it
picks which queued task runs next. No timer, no microtask and no clock decides
the order, so the same program under the same interleaving executes the same
order every time. Like Effect's own scheduler, it also yields a fiber that has
run `FiberRef.currentMaxOpsBeforeYield` ops in one go, 2 048 unless the program
sets it, so a fiber that busy-polls for another still lets it run.

A preemption can fall between any two ops of a fiber, including two synchronous
ones with nothing between them a test could wrap, and inside an
`Effect.uninterruptible` region, which stops interruption but not scheduling.
That is the reach fast-check's own `fc.scheduler` lacks: it reorders only at the
promises a test wraps, and in the prototype this export came from
(dev-config#140) it found none of the four subtle bugs planted there.

Everything rests on three things Effect 3.22's runtime does: it asks the
scheduler before every op; it names the fiber each task is for, which the
priority strategy ranks by and the wind-down finds the run's fibers by; and it
schedules a fiber's yield as that fiber's own continuation, which is how a yield
is told apart from work the fiber hands to others. The first `simulate` in a
process runs two small programs that check all three, and throws if one fails.
So a repo whose Effect stopped doing any of them fails its race properties
loudly, instead of passing them by finding nothing or leaving each run's fibers
alive.

The arbitrary mixes two strategies, because the prototype needed both to find
its races:

- a random walk, which preempts at up to 60 generated op indices and then picks
  the next task from generated choices. A pick is an index taken modulo the
  queue's length, so it reaches every queued task.
- a priority strategy, PCT (Burckhardt et al., ASPLOS 2010), which gives each
  fiber a generated priority, always runs the highest, and drops a fiber below
  every other when it yields of its own accord and at up to three generated op
  indices. A fiber that hands the scheduler work for others keeps its
  priority: releasing a lock to the fibers waiting on it, or opening a latch,
  is not a yield. Up to 24 priorities are generated, so fibers the run meets
  after the 24th all get 0.

## What a program may contain

Only its own fibers. A fiber waiting on anything outside the program waits on
something no interleaving controls, so at the end of the run it looks parked,
and the property reads a deadlock that is not there. A real timer waits that
way: `Effect.sleep`, and the timer behind a timeout, which never fires inside a
run. So does real I/O: a database driver and `fetch`. So does every promise,
including one that is already resolved, because a promise settles on a
microtask and the run has ended by then. An in-memory fake written as an `async`
function parks the run just as a real call would. Put each behind a service the
test replaces with an in-memory one written in Effect, completing through a
`Deferred` or a `Ref`.

`TestClock` parks the run too: before it moves the clock, `TestClock.adjust`
waits on a real `setTimeout` for the program's fibers to settle, so code that
sleeps or times out cannot be driven by it here. Give such code a `Clock` the test provides, whose
sleeps complete through a `Deferred` the test completes, or keep the sleeping
branch outside the program under the scheduler and test it on `TestClock`
alone.

For the run's duration `simulate` replaces `Math.random`, and provides the
program a `Random` service, each drawing from a generator seeded by the
interleaving, then puts `Math.random` back. That covers Effect's hashing of
plain objects, which draws from `Math.random`, so a `HashSet` or `HashMap` keyed
by them iterates in the same order on every run of one interleaving. A program
that reaches past these for anything that differs between runs is not
replayable: the clock, and anything the process keeps across runs, such as
fiber ids, which count up for the life of the process.

Whatever a waiting fiber was waiting on is let go when the run winds down: the
wait is interrupted, so a timer is cleared, and a promise that settles later
wakes nothing. A wait that interruption cannot reach is not let go: one inside
an uninterruptible region, such as the acquire of `Effect.acquireRelease`, or a
finalizer that never completes. The parked verdict counts such fibers in
`stranded`, and they stay alive for the life of the process, with the run's
root among Effect's roots. A property that asserts `parked: false` fails on the
first such run, so what it strands is that run's fibers and those of the runs
fast-check shrinks it with, not its whole budget.

## Sizing `ops` and the run count

`ops` decides where the generated preemptions fall: the walk's preemption points
and the priority strategy's change points are drawn below it. Size it to the
program's run under `unpreempted`, which is what `interleavingsOf(program)`
does. That count stops where the run finished or parked: the wind-down's ops
are not in it, since no interleaving schedules them. Most runs under a generated
interleaving are longer, since every preemption adds the ops of a yield, though
a different order can also take a shorter path through the code. When the
program is built from generated operations, size `ops` from the largest program
the generator produces, and generate both:

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
`bun tests/interleaving-measure.ts`, which re-takes the table. The share is the
failing runs among 20 000 generated on seed 1. The runs to find are the
`numRuns` at which `fc.check` with `endOnFailure` failed, on each of seeds 1 to
20, capped at 3 000; every seed found every race.

| Fixture                                   | `ops` | Strategy | Share failing | Median runs to find | Slowest of 20 seeds |
| ----------------------------------------- | ----- | -------- | ------------- | ------------------- | ------------------- |
| a check-then-act across a yield           | 61    | walk     | 36%           | 2                   | 7                   |
|                                           |       | priority | 29%           | 5                   | 14                  |
|                                           |       | mixed    | 32%           | 3                   | 12                  |
| a lost update between two synchronous ops | 184   | walk     | 3.1%          | 31.5                | 118                 |
|                                           |       | priority | 0.96%         | 64.5                | 460                 |
|                                           |       | mixed    | 2.1%          | 41.5                | 137                 |
| a torn read across a whole write          | 50    | walk     | 0.21%         | 617                 | 1 753               |
|                                           |       | priority | 0.69%         | 74                  | 549                 |
|                                           |       | mixed    | 0.47%         | 230.5               | 1 048               |

The suite searches each with the mixed arbitrary, over 3 000 runs, the torn
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
4. In the probe, hold each cut operation at its seam, run the gap's operations
   until each has finished or is waiting, let the held ones go in the log's
   order, and judge the result as the property does.

This repo's torn read is a ledger whose deposit credits the balance and then
appends the entry, and whose reading reads the balance and then the entries. A
reading must never see an entry the balance does not pay for. The search finds
the race, and the counterexample's log is `read balance`, `credit`, `append`,
`read entries`: the reading was cut between its two reads, and a whole deposit
ran in the gap. One latch, between the reading's two reads:

```ts
test("a reading never sees an entry the balance does not pay for", async () => {
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ledger = yield* makeLedger(
        Deferred.succeed(reached, undefined).pipe(Effect.zipRight(Deferred.await(release))),
      );
      const reading = yield* Effect.fork(ledger.read);
      yield* Deferred.await(reached);
      const deposit = yield* Effect.fork(ledger.deposit);
      yield* Fiber.status(deposit).pipe(
        Effect.repeat({ until: (status) => !FiberStatus.isRunning(status) }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(deposit);
      return yield* Fiber.join(reading);
    }),
  );
  expect(read.entries).toBeLessThanOrEqual(read.balance);
});
```

The probe runs on Effect's own runtime, not under `simulate`: the latch decides
the order, and nothing else can change it. Against the racy ledger the deposit
finishes while the reading is held, and the reading sees an entry with no
balance behind it. Against a ledger whose deposit and reading take one lock,
the deposit is waiting on the lock when the reading is let go, and the reading
sees neither. Either way the deposit was in flight while the reading was held,
so the probe proves it reached the race rather than passing beside it. This
repo's suite holds that probe on the racy ledger and on the locked one.

The property stays beside the probe. It is what finds the race's siblings.

## Reading a counterexample

This applies to a program built from generated operations. The op indices in an
interleaving count every op the run executes, across all its fibers. When
fast-check shrinks the operations, removing one shifts the index of every op
after it, so the same interleaving no longer preempts at the same place and the
race disappears. Shrinking therefore keeps operations that do not take part in
the race. Expect a counterexample with more operations than the race needs, and
read the program's log to see which of them matter.
