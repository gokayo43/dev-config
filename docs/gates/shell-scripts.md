# A repo's own shell scripts

Every `*.sh` the repository tracks goes through shellcheck, on every run, with
no input to set and nothing to turn on.

Nothing else in the pipeline reads one. `lint-workflows` runs actionlint, which
shellchecks the `run:` blocks _inside_ a workflow and stops at the file
boundary; `bun run lint` is oxlint over TypeScript. What is left over is the set
that actually touches the box: the script that pipes a `pg_dump` into age and up
to R2, the one that runs `DROP DATABASE` and carries the guard keeping the drill
off production, the ones that `docker compose down -v`, the one that parses the
compose project name every one of those refusals compares against. An unquoted
expansion or a misspelt name in that set is not a lint nit.

## Which files

Every path ending `.sh` that git lists for the repository — tracked, or written
and not yet committed, and never anything `.gitignore` describes or anything
under `node_modules`. At any depth: `scripts/backup.sh` and `infra/rollout.sh`
are both read, and so is a `deploy.sh` at the root.

Not a `scripts/` directory, and not an input naming paths. What makes a script
worth reading is what is in it rather than where somebody filed it, and a gate
keyed to a directory stops covering a file the day it moves — silently, which is
the failure this gate exists to end. A repo with no shell at all has nothing to
report and says nothing.

## Which shellcheck

The one the action fetches: a pinned version and a pinned archive checksum in
`.github/actions/_lib/shellcheck.sh`, the same contract gitleaks, actionlint and
k6 carry. The tool adds checks between releases, so two runs only agree about a
script when the same binary read it, and an unpinned one is a gate whose answer
is whichever version the runner image shipped that week.

It runs with `--norc` and with an empty environment. shellcheck otherwise reads
`SHELLCHECK_OPTS` out of the environment and every `.shellcheckrc` from the
script's directory upwards — including the reader's home directory. A gate whose
answer depends on the reader's shell has no answer.

Every check shellcheck enables by default is on, which is what the severity
scale makes load-bearing here: `SC2086`, the unquoted expansion this gate exists
for, is an **info**, so a run filtered to warnings and above would be reporting
everything except the class the gate was written to catch.

## The escape hatch

A `# shellcheck disable=SCxxxx` on the line above, which is in the source and in
the diff, where a reviewer sees it — the same price every other hatch here pays.
A `.shellcheckrc` is not one: the gate does not read it, because a file that
switches a rule off for a whole repository without saying why is the hole
`CONTEXT.md`'s escape-hatch entry is about.

shellcheck parses its own directives and will not take a reason on the same
line — ` -- why` after the code is a parse error, not a comment — so the reason
goes on the line above the directive. That is the form this repo's own scripts
use.

Two more things the directive syntax decides, both of which have cost a run
here: a comment whose **first word** is the tool's own name is read as a
directive rather than as prose, and a file with neither a shebang nor a
`# shellcheck shell=` directive is refused (`SC2148`) because nothing says which
shell it is. A library meant to be sourced carries the directive.

## What it cannot see

- **Whether the script does the right thing.** shellcheck grades shell, not
  intent: a correctly quoted `dropdb` is still a `dropdb`. What holds those is
  the repo's own suite around the guards — `restore-drill.test.ts` and its
  neighbours in `project-template`.
- **A script that is not `.sh`.** An executable with a bash shebang and no
  extension is invisible here, as is a `Makefile` recipe.
- **A directive with no reason.** `suppression-hygiene` holds every lint
  directive in a repo's TypeScript to carrying ` -- why`; shell is not in its
  scope, and shellcheck's own syntax could not express the reason inline anyway.
