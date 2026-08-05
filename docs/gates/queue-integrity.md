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
comment saying why, and the run still fails. Agents file proposals freely and
never approve their own; the `labeled` event carries the actor, so that rule is
enforced rather than reported, and the invalid state does not survive the run.
The caller grants the job `issues: write` for exactly that reason.

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
