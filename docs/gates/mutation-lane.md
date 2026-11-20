# The mutation lane

Coverage says a line ran. It cannot say the suite would have noticed had the
line been wrong, and a test that executes a branch while asserting nothing about
it counts exactly as much as one that pins it. The mutation lane asks the other
question: change the code, and see whether anything fails.

StrykerJS does the changing, through `@hughescr/stryker-bun-runner` — the stock
runner does not speak `bun test`. Both are the repo's own devDependencies rather
than something this action fetches, so their versions are the ones its lockfile
pins, under the same release-age window as everything else it installs. A repo
that turns the lane on without them is told to add them by name.

## Selective, because the alternative is not affordable

A full campaign over a domain layer is minutes to hours: every mutant is a run
of the tests that cover it. A gate that costs that runs nightly, or it runs
never. So what a pull request is held to is the code in the pull request:

- the files it changed, against the base ref — the merge base with the branch it
  targets, or the tip a push had before, the same resolution [the upgrade
  gate](upgrade-path.md) and the repo contract use;
- of those, the ones under the repo's **pure domain**;
- of the mutants in those files, the undetected ones sitting on lines this
  branch wrote.

Nothing changed under the domain is a pass that says so. Everything else about
the branch — the routes, the server, the components — is outside the lane
entirely, and deliberately: a mutant of code that talks to a database is a
statement about the fake behind it.

## Where the domain is

From `.oxlintrc.json`, as the `boundaries/elements` entry the layer rule already
reads:

```json
{ "type": "domain", "pattern": "src/domain" }
```

One declaration per repo rather than two. A gate input naming the same folders
would be a second place to write down what is pure, and the day the two
disagreed the linter and this lane would be enforcing different layers. A
monorepo declares one element per project — the `pattern` takes a glob, so
`apps/*/src/domain` is one entry — and a repo that declares no domain element is
told to write one instead of being quietly excused.

`pattern` is read exactly as the linter reads it — a string or an array of them
— so a repo mixing the two forms is gated whole rather than half.

A pattern must reach a **folder**, and two shapes are refused rather than run:
one naming a file (the layer rule classifies what is _under_ a folder, so
`src/domain/pricing.ts` would match nothing), and a set of patterns where none
of them reaches a directory at all. Both would otherwise leave the lane grading
a domain of no files and reporting a clean pass.

Under those folders the lane mutates `.ts`, `.tsx`, `.mts` and `.cts`, and never
a `.d.ts`, a `*.test.*` / `*.spec.*` file, or a file the lint base's test
override names as test code (a `*.test-harness.*` or `*.fixture.*` beside a
suite). The lane reads that override out of the base in its own checkout, so the
linter and the lane mean one set by "test code", and matches each of its globs
against a file's name. A glob there that still holds a folder once its leading
`**/` is dropped cannot be matched that way, and the lane refuses the run naming
it rather than mutating the test code it was meant to keep out.

## The one failure this gate cannot afford

A filename crosses three name-spaces on its way through the lane: git's diff
output, the filesystem under the working directory, and Stryker's glob resolver.
A file that goes missing between any two of them has no mutants — and a file
with no mutants reads exactly like a file with nothing wrong. Every row below
was a green run before it was a refusal:

| What drops the file                                                          | What the lane does now                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| a name git C-quotes — a quote, backslash or control character in the path    | refuses, naming the diff header and asking for a rename        |
| a name that is itself a glob (`[id].ts`, the one every router here produces) | escapes it, so the file is mutated like any other              |
| a name no escape can express (`{`, `}` and `!` have none)                    | refuses, naming the file Stryker reported it could not resolve |
| a project below the git root (every monorepo)                                | reads the diff `--relative`, so the paths are the project's    |

The third row is why the check is _requested-versus-resolved_ rather than
escaping alone: Stryker resolves what it can and finishes cleanly over the rest,
printing one `Glob pattern "…" did not result in any files.` per entry it could
not place. That line is read on **every** exit, not only a failing one, because
the run it belongs to is otherwise green.

A file that resolves and simply holds no mutants — one of types, say — is not
this. It is a pass that says so.

## Which mutants fail the branch

A mutant fails the branch when **every line it spans** is a line this branch
wrote. Containment rather than overlap, and the difference is not a detail: a
one-line edit inside an existing function sits inside a mutant of the whole
enclosing block, and failing on that one would fail the branch for code it did
not write. The block belongs to whoever wrote the block.

Three statuses count as undetected on a line this branch wrote, and they ask for
different things:

| Status       | What it means                                 | The diagnostic asks for              |
| ------------ | --------------------------------------------- | ------------------------------------ |
| `Survived`   | tests ran the line and all passed             | a case that fails on the replacement |
| `NoCoverage` | no test reached the line at all               | a test that reaches it               |
| `Ignored`    | a `// Stryker disable` took it out of the run | the test, or the directive gone      |

`Killed` and `Timeout` are caught. A mutant that would not compile, and one the
config declined, is neither caught nor missed: outside the ratio rather than a
zero in it — Stryker's own definition of the score, kept rather than reinvented.

**A mutant the run produced no verdict for is the third thing**, and the one
place that definition cannot be kept. `RuntimeError` and `Pending` leave the
ratio the same way, so a run in which every mutant errored scores nothing at
all — and exits 0. Measured on fec-program: 121 of 121 mutants `RuntimeError`,
86 of them not static, Stryker exit 0, and a lane that reported the changed
files as holding no mutants and passed.

**Everything below depends on the suite passing unmutated**, which is the check
the section after this one is about. Only then does "the mutant is why this
mutant has no verdict" follow at all — and only then is the report's own `static`
field a reading of anything:

| `static`           | What an errored mutant means                                          | What the lane does                                            |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `true`             | it runs at module load, so a run it ended did so before any test ran  | leaves it out of the ratio, counted in the **Not graded** row |
| `false`, or absent | it is only ever active inside a test, so it cannot be why no test ran | fails the lane, wherever in the file it sits                  |

A static mutant never fails the branch: there is no test anyone could write for
one, and a `// Stryker disable` on a line the branch wrote counts here as a
mutant nothing caught — so failing it would be a red with no exit. A static
mutant that makes its file throw on import never gets here: the runner reads a
test file that fails to load as a failing suite and scores the mutant caught.

Every other ungraded mutant is a statement about the run rather than about the
branch, and the score would be published over whatever fraction of the mutants
got a verdict. So it fails the lane wherever those mutants sit, own lines or not,
as **one** problem for the whole class. With the baseline guaranteed clean this
is boundary validation rather than a state anything has been seen to reach: it
refuses a report the runner should not be able to write.

**`Ignored` — a `// Stryker disable` in the source — is the one status whose
worth depends on where it sits.** Out of the ratio it takes the mutant from
_both_ sides of the fraction, so a branch that wrote an untested line and
disabled it scored **higher** than one that only wrote the line — 100% against
50% — and cleared a floor it should have breached. On a line the branch wrote,
the directive is the branch's own choice and counts as a mutant nothing caught.
Elsewhere it is somebody's earlier decision, and outside is the honest reading.

A `// Stryker disable` also has to say **why**, in the ` -- reason` form every
other suppression in this house pays. That is not enforced here: it is
[suppression hygiene](suppression-hygiene.md), which holds every disable in the
tree to the same rule whichever tool reads it. Stryker honours the reason in any
of its three spellings — bare, `: reason` and ` -- reason` — so carrying one
costs the directive nothing.

## Which tests the run loads, and whether it passed

Two ways, and the repo picks.

**Walked, the default.** `@hughescr/stryker-bun-runner` finds the tests itself.
It walks the project for every file whose name ends `.test.` or `.spec.`
followed by `ts`, `tsx`, `js`, `jsx`, `mts` or `mjs`, skipping `node_modules`,
`dist`, `build`, `.stryker-tmp` and `.git`, and hands that list to one plain
`bun test`. A suite in the tree that was never meant for a plain `bun test` is
loaded whatever else is supposed to run it: a Playwright spec throws where it
stands (_Playwright Test did not expect test() to be called here_), and a suite
that needs a database, or that passes only under the repo's own wrapper, fails.
The repo's own `bunfig.toml`, which the runner forwards into the sandbox it
builds, keeps such a suite out:

```toml
[test]
pathIgnorePatterns = ["e2e/**"]
```

Bun honours that key even for a file named on the command line, which is how it
reaches a list the runner built rather than one a flag selected. On fec-program
it turned a run of 121 mutants, every one of them `RuntimeError`, into 115
Killed, 4 Timeout, 1 Survived and 1 static `RuntimeError`.

**Named, with `mutation-tests`.** Where the domain's tests are a small part of a
large suite, the repo names them instead: glob patterns relative to the working
directory, one per line.

```yaml
with:
  mutation-lane: true
  mutation-tests: |
    src/domain/**/*.test.ts
    tests/pricing/*.test.ts
```

The lane resolves the patterns to files and hands exactly those to the runner's
`bun.testFiles`, each as a path beginning `./`. The prefix is load-bearing: bun
reads a bare relative path as a substring filter, so `lib/a.test.ts` also runs
`other/lib/a.test.ts` and `lib/a.test.tsx`. An absolute path is no better, since
it points the runner at the original files rather than the sandbox copy it
mutates. Bun's glob takes the extglob form, so a pattern can leave a kind of
suite out: `app/lib/**/!(*.db|*.dom).test.ts`.

Where the domain's tests live is a fact only the repo holds, which is why it is
an input and not a rule the lane derives from the layout. Each of these is
refused by name before Stryker starts, because each would grade the domain with
fewer tests than the repo meant and publish the score anyway:

- a pattern that matches no file;
- a pattern that is absolute or climbs out with `..`, since the sandbox copies
  only the working directory;
- a blank line between patterns (the newline a YAML block ends with is not one);
- a named file `bunfig.toml`'s `[test] pathIgnorePatterns` matches, which bun
  would skip even though it is named.

A `bunfig.toml` that sets `[test] retry` above 0 is refused by name too, walked
or named: bun's command line cannot switch the bunfig's retry off, and a
retried test would grade a mutant on whichever try passed. A `bunfig.toml` that
cannot be read is refused as unreadable, before either rule is asked.

**The named tests are run unmutated first**, by the lane itself, whenever the
branch changed a domain file or a named test file: one `bun --no-env-file test`
of exactly the named files, under the case limit below, with bun's JUnit report
read for which file failed. A file whose cases failed is a `testsuite` counting
failures; a file that threw before its cases ran has no `testsuite` at all. Each
is refused by name, before Stryker starts. A branch that changed a named test
and no domain file stops there, green or refused, so a pull request that breaks
a named test is the one told, rather than the next pull request to touch the
domain.

Naming fewer tests never turns a missed mutant into a pass. A mutant on the
branch's own lines that the named tests leave `Survived` or `NoCoverage` fails
the branch as it would walked, so a domain file whose only test sits outside the
patterns fails until that test is named or written beside it. The note says how
many test files the patterns named.

**Until that is done, nothing in the report means anything**, and Stryker's own
verdict on its dry run does not say which. What the lane reads instead is the
runner's own line, logged at default level whenever bun reported a failure and
no test it could name accounts for it. `@hughescr/stryker-bun-runner` 1.6.0
writes it in two forms. A spec file that fails to load ends the dry run with an
error, a non-zero exit and no report:

```
ERROR BunTestRunner stryker-bun-runner: dry run data-completeness check failed —
bun's console summary reported 1 failing test(s), but none of them could be
attributed to an individual test — … Last 500 chars of stderr:
```

Any other unattributed failure, such as an error thrown between tests, lets the
run go on to a report and logs a warning:

```
WARN BunTestRunner Bun exited with code 1 and its console output reported 1 failed
test(s), but no failing test could be identified from inspector or console data.
… Last 500 chars of stderr:
```

Named tests reach Stryker only once the lane's own run of them passed in the
checkout, so for them this line is the backstop for what differs in Stryker's
copy: the sandbox holds no `.env*` file and nothing outside the working
directory, and the runner forwards only some of `bunfig.toml`'s `[test]` keys.
Walked, it is the only check.

That line present, the lane refuses the run and quotes the stderr the runner kept
— which is what names the file that would not load — and says which way the
tests were chosen: walked, it points at `mutation-tests` and
`pathIgnorePatterns`; named, at those differences. It is read on **every** exit,
before the report is opened, for the reason the unresolved-pattern check is: the
run the warning belongs to is otherwise green.

It matters in both directions. A spec that throws before the unit tests run turns
every mutant into a `RuntimeError` that the `static` reading above would then
misread as an exemption — the measured case is a one-line branch whose own
survivor came back `RuntimeError, static: true`, and the lane called it an
exemption and passed. A spec that throws _after_ them is worse: the tests have
already printed, so a mutant nothing killed can come back `Killed`, and no
reading of statuses recovers that.

## What a timeout means

Four clocks can end a test run in the lane. The first two follow
`mutation-case-timeout`, the other two follow the lane's deadline for its whole
run. The first two are set so that a mutant's run ends on one only when it
hangs; the run's deadline ends a run that hangs and also one that is simply
too long:

| Clock                                    | Its default                                   | In the lane                                     |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| bun's limit on one case                  | 5 s                                           | the case limit, `--timeout` on every `bun test` |
| Stryker's deadline for one mutant        | 1.5 × what its tests took unmutated, plus 5 s | 1.5 × what its tests took, plus the case limit  |
| the runner's clock on a `bun test` child | 10 s                                          | the run's deadline                              |
| Stryker's limit on its own unmutated run | 5 minutes                                     | the run's deadline                              |

The **case limit** is `mutation-case-timeout`, in milliseconds as bun's
`--timeout` takes it: decimal digits from 1 to 540000, the run's deadline, and
60000 when empty. A case allowed longer than the whole run is allowed nothing
more, and the cap keeps Stryker's deadline for a mutant inside the 2147483647
ms Node's timers take, past which a timer fires after 1 ms and every covered
mutant came back caught by timing out. A `[test] timeout` in the repo's
`bunfig.toml` changes nothing: the runner copies the key into Stryker's
sandbox, and bun ignores it, as the test-suite gate's page says. Stryker's
deadline is built from the flag, so one case's limit beyond what the tests took
is the slack a run gets before it is a hang.

The **run's deadline** is nine minutes from the lane's start, inside the ten
`check.yml` gives the step. The named tests' unmutated run and Stryker both end
at it, and the runner's clock and Stryker's dry-run limit are set to it, so
neither can grade a mutant in place of Stryker's deadline however long the
covering tests take. A run the deadline ended is refused, never graded: the
named tests' unmutated run with a note saying they did not finish, since bun's
case limit cannot end a case that never yields, and Stryker's with its last
count, how many mutants it had tested and how many had timed out. A mutant that
hangs holds a worker for one case limit, so a changed file full of loops is one
thing that reaches the deadline, and where mutants had timed out the refusal
points at `mutation-case-timeout`; where none had, the run was simply long, and
it points at fewer changed domain files in one branch or faster named tests.

At the defaults one commit got a different verdict on every run (dev-config#203,
measured on A1M4N3/wmstcs: 35 named test files, three changed domain files, six
runs, three on a quiet machine and three beside the repo's own suite). 69 of its
253 mutants changed status between the runs, and the score moved between 65.7%
and 83.4%. Most were static mutants: each reloads every named file, and against
a deadline of 1.5 × 1.3 s + 5 s the parallel runs around it timed it out, which
counts as caught, on some runs and not on others. Under load the rest followed:
a survivor on a line the branch wrote passed as caught by timing out, and a
property test that takes 1.4 s alone took 6.6 s, crossed bun's five seconds and
failed the unmutated run outright. With Stryker's deadline and the runner's
clock set as above but bun's limit left at five seconds, the runs beside the
suite turned survivors into kills instead, and 67 mutants still changed status.
With all three clocks the same six runs graded every mutant alike, at 57.0%,
with no timeout among them. Each of the 69 was then applied by hand and its
test files run alone: the 20 the lane now calls killed die, the 47 it calls
survivors live, and 14 of those had been called killed by an earlier run; the
other 2 throw at module load, outside the ratio.

What it costs is the time the slow runs used to be cut short at: that commit's
lane took 71 to 118 s on a quiet machine and 155 to 167 s beside the suite,
against 47 to 57 s and 122 to 127 s at the defaults.

A timeout counts as caught, as Stryker counts it, and the lane never retries a
test or a mutant for a different answer. What it adds is the count: the note
says how many of the mutants caught were caught by timing out, wherever any
were, and the summary has a **Caught by timing out** row, so a score that rests
on timeouts is seen to. A mutant that hangs costs one case limit of one worker;
a repo whose hangs are many lowers the limit to what its slowest case needs.
At the default that is a minute a hang, where Stryker's defaults ended one at
1.5 × what its tests took unmutated, plus 5 s.

## The score, and the floor

The mutation score over the files the branch touched goes to the run summary
whenever at least one mutant counts toward it, passing or failing, with the
undetected mutants on the branch's own lines listed under it and a **Not
graded** row counting the mutants the run produced no verdict for — which, on
any run that reaches the summary at all, are exactly the static ones, because the run's suite passed unmutated and every other
no-verdict mutant is a refusal. Counted there rather than left silent, because a
campaign that graded fewer mutants than it made is the thing a score cannot say.

That list and the step's problems name the undetected mutants in one order: by
file, then first line, last line, mutator, replacement and status, each text
compared by code unit. Stryker writes a mutant to its report when that mutant's
run finishes, so the report's own order changes from run to run; the lane sorts
the findings, and two runs over one branch list them in the same order. The
floor's problem, where there is one, comes after them.

`mutation-floor` is what turns that number into a bound, and it is empty by
default — publish only. It is written as a fraction between 0 and 1, the way
`bunfig.toml` writes `coverageThreshold`, and anything else is refused rather
than guessed at. What it means is what the coverage floor means, and the
paragraph in README's "Tests and coverage" is the whole argument: **a floor, not
a target.** It sits at or below what the repo's domain already scores, it is
raised only after the tests are there, and a floor above current reality is a
red CI run that teaches everyone to ignore red CI runs.

The floor and the containment rule cover each other. Containment lets a mutant
past when a branch edits one line of a block it did not write; the floor is
still measured over every mutant in every file the branch touched, so a file
whose score is falling says so whoever wrote the lines.

## Turning it on

```yaml
with:
  mutation-lane: true
  mutation-floor: "0.7"
```

`mutation-floor`, `mutation-tests` or `mutation-case-timeout` without `mutation-lane: true` fails the
run rather than being ignored, for the reason the database inputs do: a bound
nobody notices is off is a bound nobody has.

The repo declares `@stryker-mutator/core` and `@hughescr/stryker-bun-runner`
among its devDependencies — the lane runs the repo's own install, so the
versions are the ones its lockfile pins. Declare the pair this repo's own
devDependencies pin: the lane's own diagnostic, when it finds neither
installed, names that exact pair, since it is the one the lane is verified
against. Nothing imports either of them, so knip reports both as unused and
`bun run knip` fails a step before the lane ever runs. `knip.base.ts` exports the pair for the repo's own
config to spread:

```ts
import { base, mutationLaneDependencies } from "@gokayo43/dev-config/knip.base.ts";

const config: KnipConfig = {
  ...base,
  ignoreDependencies: [...mutationLaneDependencies],
  // …
};
```

The names are the gate's and live in one place; the spread is the repo's,
because whether it runs the lane is not a fleet-wide fact. The base cannot carry
the ignore itself: `treatConfigHintsAsErrors` turns an ignore matching no
declared dependency into an error, so every repo that does _not_ run the lane
would fail knip the day its pin moved.

**What a runner needs.** Two things beside the Bun that runs the lane. A run
without either exits 1 with no report and only a stack trace to say why, so
when a run exits without a report the lane names, after the run's log, each one
the machine lacks and what to change on it; the repo can change neither. Each
is named as a likely cause of the exit, never a certain one: the lane asks
none of this before Stryker starts, since whether Stryker runs on a machine is
answered only by running it there, and a machine that lacks one by these rules
and runs Stryker anyway is graded as any other.

- **Node.js that every package Stryker loads accepts.** Stryker's command
  starts `#!/usr/bin/env node`, so it runs under the `node` on `PATH`, and that
  Node has to satisfy the `engines.node` of every package in the installed
  dependency tree of the two the repo declares. Stryker's own declaration is
  not the strictest: `@stryker-mutator/core` 10.1.1 declares `>=22.0.0` and
  parses the code with Babel 8, which declares `^22.18.0 || >=24.11.0`, and
  under a Node 22 before 22.12 Babel's `require()` of its own ES modules fails.
  At the pair this repo pins that means Node 22.18 or later in the 22 line, or
  24.11 or later. `engines.node` is advisory, and npm installs past a
  mismatch with a warning. After a run that exited, a runner with no `node`, or
  one whose `node` does not answer for its version, is told to install one, and
  one whose `node` falls outside a range is told its version and each range it
  misses, with a package that declares it.
- **A temp dir no other user can tamper with, all the way up.**
  `@hughescr/stryker-bun-runner` writes a script under its temp dir that every
  `bun test` of the run executes, and since 1.6.0 it refuses one with any
  directory above it owned by a user other than the runner's or root, or
  writable by group or others without the sticky bit. The lane hands it a
  `0700` directory inside its own scratch directory, under `TMPDIR`, so what
  decides is the directory `TMPDIR` names and every one above it. `/tmp` passes,
  being root's with the sticky bit; a runner's own temp directory created under
  a umask of `002`, mode `0775`, does not. The lane names every such directory
  with the `chmod` that fixes it: `chmod go-w`, or `chmod +t` for one that has to
  stay shared.

**Running it by hand.** Start the lane from its own checkout with every input it
reads set, and with bun told to leave the checkout's `.env` alone, since bun
loads it into the process otherwise and every child inherits what it set:

```sh
INPUT_WORKING_DIRECTORY=. INPUT_BASE_REF=main INPUT_BEFORE= INPUT_MUTATION_FLOOR= \
INPUT_MUTATION_TESTS= INPUT_MUTATION_CASE_TIMEOUT= INPUT_STEP_SUMMARY=/dev/null \
  bun --no-env-file <dev-config checkout>/.github/actions/mutation-lane/mutation-lane.main.ts
```

`INPUT_BASE_REF` names the branch the change is measured against, as
`refs/remotes/origin/<it>`. No test the lane runs reads a `.env` file either:
the named tests' unmutated run is made in the checkout, where the files are on
disk, and starts bun with `--no-env-file`, so none of them reaches the
environment; Stryker's copy of the project leaves out every `.env*`. A suite
that needs one, such as a tracked `.env.test`, fails unmutated in the lane.

The lane keeps Stryker's sandbox outside the checkout
and cleans it whatever happens, so a CI run leaves nothing behind. The runner
writes a bunfig and a preload per worker under the temp dir and leaves them
when its worker is killed; the lane runs Stryker with `TMPDIR` inside its own
scratch directory, so those go with it. And every process the lane starts runs
in a group of its own, which the lane kills when it ends the run and again once
the child has exited, so nothing left in that group outlives the lane; a
process that starts a session of its own leaves the group and is outside the
lane's reach. An interrupt of the lane, a Ctrl-C or a cancelled step, is
passed on to that group, a second one kills it, and the lane then ends by the
first. Stryker's own
defaults do not: `bunx stryker run` writes `.stryker-tmp/` beside the project
and an HTML report under `reports/mutation/`. Add both to the repo's
`.gitignore` before running it locally. A hand run also needs the
`"tsconfigFile": ""` the lane writes, for the reason `strykerConfig` gives:
Stryker's tsconfig rewrite calls a TypeScript API the fleet's TypeScript does
not export, so without that line the run dies on any repo that has a
`tsconfig.json`.

## What it cannot see

- **A domain that is not declared as a layer.** The lane reads one key of one
  file. A repo whose pure code lives somewhere the boundaries matrix does not
  name gets no lane until it says so — which is the correct order, since the
  linter is not enforcing that layer either.
- **A change whose mutants all sit in a block it did not write.** Containment is
  a choice about who is answerable, not a claim that those mutants are fine. The
  floor is what still counts them.
- **A suite that passes for the wrong reason.** A mutant is killed by any
  failing test, including one that fails for an unrelated reason. Mutation
  testing grades the suite's sensitivity, not its correctness.
- **Anything outside the domain.** By construction, and see above.
- **A single stale domain pattern beside a live one.** Only a set where nothing
  reaches a folder is refused; one element pointing at a project that has no
  domain folder yet under-gates without a word. Naming it would fail a workspace
  scaffolded a project at a time, which is a real state and a worse trade.
- **A named test broken through what it imports.** The named tests run
  unmutated when the branch changed a domain file or a named test file. A
  branch that breaks one through a helper or harness it imports changes
  neither, so it passes here, and the next branch to change a domain file
  meets the red run.
- **A test that retries itself.** A case written with bun's `{ retry: n }`
  passes on any of its tries under every flag, so a mutant it should kill on
  the first try can pass on a later one. The lane refuses a `retry` in
  `bunfig.toml`, which it can read; the option on a case it cannot see.
- **A dirty baseline the runner stops announcing.** The check above reads the
  log lines `@hughescr/stryker-bun-runner` writes — the warning seen in runs of
  1.3.8 and 1.4.0 and still in 1.6.0's source, the error seen in runs of 1.6.0
  — and nothing in the report states
  the same fact, so a runner that stopped logging them would stop being refused
  here. What notices is this repo's own suite: its
  mutation-lane cases drive real Stryker over a fixture with a throwing spec in
  it, so the day that line changes they go red rather than green.
