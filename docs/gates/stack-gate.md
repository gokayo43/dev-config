# The stack denylist

`STACK.md` picks one library per slot. `stack-gate` is that document with an exit
code: one `stack-denylist.json` in this repo, read against every `package.json`
in the tree.

An entry is a set of package names and the reason they lost, so the diagnostic
teaches the rule rather than only refusing the package:

```
::error file=package.json::dependencies.dayjs is not the house pick — Temporal on the server, @date-fns/tz in the client
```

An entry lists `names`, matched exactly, and `patterns`, which are regular
expressions over the package name. Two fields rather than one convention,
because the distinction is load-bearing in both directions: `^@radix-ui/` has to
take a whole scope, and `jest` must not take `jest-expo` — the Expo test preset
is the only way to run a React Native suite, and it is not the thing the entry
is about.

One kind of pick is a judgement call rather than a rule, and its entry carries an
`adr` glob: the packages unlock once that file exists. Client state management is
the case the canon names. The escape hatch is deliberately the same work as
writing the decision down, which is the only form of exception worth having.
