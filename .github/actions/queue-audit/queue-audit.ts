import type { Problem } from "../_lib/gate.ts";

export interface Label {
  readonly name: string;
}

export interface Issue {
  readonly number: number;
  readonly labels: readonly Label[];
  readonly body: string | null;
}

/** Where the queue is read from. Injected so the rules can be driven without a repo. */
export interface Queue {
  labels(): Promise<Label[]>;
  openIssues(): Promise<Issue[]>;
}

export interface QueueRules {
  /** Every label the repo is allowed to carry. A label outside it is a taxonomy nobody drains. */
  readonly vocabulary: readonly string[];
  /** The buckets an open issue sits in — exactly one, or its state is a guess. */
  readonly stateLabels: readonly string[];
  /** Marks an issue whose body names the event that makes it due. */
  readonly commitmentLabel: string;
}

/**
 * The canon queue, in one place. The action and the workflow wrapping it both
 * declare their inputs as empty-means-canon rather than repeating the list:
 * three copies of a vocabulary are three chances to disagree about it.
 */
export const CANON: QueueRules = {
  vocabulary: [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "roadmap",
    "commitment",
    "wontfix",
  ],
  stateLabels: [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "roadmap",
    "wontfix",
  ],
  commitmentLabel: "commitment",
};

const TRIGGER = "**Trigger:**";

export async function queueAudit(queue: Queue, rules: QueueRules): Promise<Problem[]> {
  const [labels, issues] = await Promise.all([queue.labels(), queue.openIssues()]);
  const problems: Problem[] = [];
  const allowed = new Set(rules.vocabulary);
  const states = new Set(rules.stateLabels);

  for (const { name } of labels) {
    if (!allowed.has(name)) {
      problems.push({ message: `label '${name}' is outside the queue vocabulary — delete it` });
    }
  }
  const present = new Set(labels.map(({ name }) => name));
  for (const name of rules.vocabulary) {
    if (!present.has(name)) problems.push({ message: `label '${name}' is missing from this repo` });
  }

  for (const issue of issues) {
    const names = issue.labels.map(({ name }) => name);
    const held = names.filter((name) => states.has(name));
    if (held.length !== 1) {
      problems.push({
        message:
          held.length === 0
            ? `issue #${issue.number} carries no state label — an unlabelled issue is invisible to whoever drains the queue`
            : `issue #${issue.number} carries ${held.join(" and ")} — an issue is in exactly one state`,
      });
    }
    if (names.includes(rules.commitmentLabel) && !(issue.body ?? "").includes(TRIGGER)) {
      problems.push({
        message: `issue #${issue.number} is a commitment with no '${TRIGGER}' in its body — a commitment nobody can check is a wish`,
      });
    }
  }

  return problems;
}
