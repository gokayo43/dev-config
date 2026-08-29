# The stack denylist

`STACK.md` picks one library per slot. `stack-gate` is that document with an exit
code: one `stack-denylist.json` in this repo, read against every `package.json`
in the tree.

An entry is a set of package names and the reason they lost, so the diagnostic
teaches the rule rather than only refusing the package:

```
::error file=package.json::dependencies.dayjs is not the house pick — Temporal on the server, @date-fns/tz in the client; a deviation someone agreed to goes in stack-allowlist with its reason
```

An entry lists `names`, matched exactly, and `patterns`, which are regular
expressions over the package name. Two fields rather than one convention,
because the distinction is load-bearing in both directions: `^@radix-ui/` has to
take a whole scope, and `jest` must not take `jest-expo` — the Expo test preset
is the only way to run a React Native suite, and it is not the thing the entry
is about.

Both are matched against the package a manifest installs, which is not always
its key: `"db": "npm:prisma@6"` installs prisma, and the diagnostic names the
key so the line can be found and the package so the rule reads. Only what is
installed is graded — `"prisma": "npm:drizzle-orm@0.44.7"` is the house pick
under an unfortunate local name, and it passes.

## Keeping a package anyway

Some picks are a judgement call rather than a rule — client state management is
the case the canon names — so the denylist has one way past it: the caller names
the package in `stack-allowlist`, with the reason.

```yaml
with:
  stack-allowlist: |
    zustand -- the editor's transient selection, agreed as the one client-state deviation
```

One entry per line, `<package> -- why`. The package is matched exactly as a
manifest spells it, including one a `patterns` entry denies: what a waiver
names is the dependency, not the rule it is standing against. For an aliased
dependency either spelling will do — the key or the package it installs —
since both name the one line someone was looking at. A waiver is repo-wide: it
covers that package wherever any manifest in the tree declares it, not one
workspace, because what was agreed is a fact about the repo.

The why itself lives in the deviating repo's `CLAUDE.md`, which is where the
canon records a deviation and the only place it is written out. What the entry
carries is the line that stands for it here, not a second account of the
decision.

The reason is the whole price, the same one a lint directive pays — an exemption
nobody had to justify is indistinguishable a year later from a bug someone
silenced.

An entry the gate refuses rather than obeys is one of three: it carries no
` -- why` after the package; it names a package this tree no longer declares, so
the deviation it was written for is gone; or it names one the denylist has
stopped answering for, which is the entry a retired denylist entry leaves behind
in every repo that had waived it. The last two are told apart in the diagnostic,
because only one of them can be a misspelling: when the package is right there
in the manifest, the entry is dead because the rule it stood against is gone,
and there is no name to go hunting for.

The hatch is an input rather than a file in the repo because a deviation is
something someone agreed to. It belongs where the repo's other exemptions are
declared — in the call into `check.yml`, visible in the diff that adopts it and
reviewed with it.
