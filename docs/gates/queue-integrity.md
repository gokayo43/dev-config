# Queue integrity

The issue queue is the register for everything not being done right now, and it
decays quietly: a label outside the vocabulary, an issue in no state, a
commitment whose trigger nobody wrote down. Two reusable workflows hold it.

Two triggers, so two files: one `if:` at a call site to sort out which half of
a merged workflow is meant to run is a branch that only exists because the
files were merged.

```yaml
# .github/workflows/queue-promotion.yml
name: Queue promotion
on:
  issues:
    types: [labeled]
permissions:
  contents: read
jobs:
  guard:
    permissions:
      contents: read
      issues: write
    uses: gokayo43/dev-config/.github/workflows/queue-guard.yml@<commit sha> # <release tag>
```

```yaml
# .github/workflows/queue-weekly.yml
name: Queue weekly
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  audit:
    permissions:
      contents: read
      issues: read
    uses: gokayo43/dev-config/.github/workflows/queue-audit.yml@<commit sha> # <release tag>
```

`queue-guard` takes the promotion back when anyone but the repo owner adds
`ready-for-agent` or `ready-for-human`: the label comes off, the issue gets a
comment saying why, and the run still fails. The caller grants the job
`issues: write` for exactly that reason.

### What the guard does and does not bind

Worth being exact, because the obvious reading is wrong in two places.

**It binds a third-party account.** Another person, or an app with its own
identity, labelling an issue produces a `labeled` event, the workflow runs, and
the label does not survive it.

**It does not see a label applied with the repo's own `GITHUB_TOKEN`.** GitHub
does not start a workflow run from an event a job token created — documented
behaviour, and the reason a workflow cannot trigger itself. In-repo automation
promoting an issue therefore produces no run at all, red or green. The weekly
audit closes that: for every open issue carrying a promotion label it reads the
timeline and checks that the _latest_ application of that label names the owner.
The gap narrows from "never noticed" to "noticed within a week", which is what
a schedule can buy and no more.

**It cannot see an agent using the owner's account at all.** An agent acting
through the owner's credentials is the owner in the event payload, in the
timeline, and in the API — there is no field that differs. Nothing here
distinguishes them, and no rewriting of this gate would; it needs a separate
principal for agents, which is a decision for the repo owner rather than
something a gate can assume. Until then, "agents never promote their own
proposals" is a rule the canon states and this gate enforces only against
identities that differ from the owner's.

`queue-audit` reads the labels and every open issue on a schedule and asserts
three things: the vocabulary is exactly the canon set and nothing else, every open
issue carries exactly one state label, and every issue labelled `commitment`
states a `**Trigger:**` in its body. Its inputs carry the canon defaults:

| Input              | Default                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `vocabulary`       | `needs-triage needs-info ready-for-agent ready-for-human roadmap commitment wontfix` |
| `state-labels`     | `needs-triage needs-info ready-for-agent ready-for-human roadmap wontfix`            |
| `commitment-label` | `commitment`                                                                         |

`commitment` is the marker orthogonal to the state machine: a commitment is
already in one of the six states, and the label is how the issues with a trigger
are found on the day their trigger may have fired. GitHub's own starter labels —
`bug`, `enhancement`, `duplicate` and the rest — are a taxonomy nobody drains, so
the audit refuses them; the scaffolder deletes them when it creates the canon
set.
