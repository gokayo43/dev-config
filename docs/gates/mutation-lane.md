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
a `.d.ts` or a `*.test.*` / `*.spec.*` file.

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

`Killed` and `Timeout` are caught. A mutant that would not compile or that
errored is neither caught nor missed: it is outside the ratio rather than a zero
in it — Stryker's own definition of the score, kept rather than reinvented.

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

## The score, and the floor

The mutation score over the files the branch touched goes to the run summary
every time, passing or failing, with the undetected mutants on the branch's own
lines listed under it.

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

`mutation-floor` without `mutation-lane: true` fails the run rather than being
ignored, for the reason the database inputs do: a bound nobody notices is off is
a bound nobody has.

The repo declares `@stryker-mutator/core` and `@hughescr/stryker-bun-runner`
among its devDependencies — the lane runs the repo's own install, so the
versions are the ones its lockfile pins. Pin the core to a **9.x**: a bare
`bun add` resolves 10, which is outside the `^9.0.0` peer range
`@hughescr/stryker-bun-runner` declares. The lane's own diagnostic, when it
finds neither installed, names the exact pair it is verified against. Nothing imports
either of them, so knip reports both as unused and `bun run knip` fails a step
before the lane ever runs. `knip.base.ts` exports the pair for the repo's own
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

**Running it by hand.** The lane keeps Stryker's sandbox outside the checkout
and cleans it whatever happens, so a CI run leaves nothing behind. Stryker's own
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
- **How long a campaign may take.** Stryker's `timeoutMS` is per mutant, not per
  run, so the bound is a `timeout-minutes` on the calling step in `check.yml`.
