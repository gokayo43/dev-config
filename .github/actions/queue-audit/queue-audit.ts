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
  commitmentLabel: "commitment",
};

const TRIGGER = "**Trigger:**";

/**
 * A tripwire, not an enforcer. Which label an issue carries is a convention the
 * canon states and agents follow; nothing here checks who applied one. These
 * two things are the ones that rot silently and that nobody would notice: a
 * vocabulary that has drifted, and a commitment whose trigger was never
 * written down — a promise with no date is a promise nobody can check.
 */
export async function queueAudit(queue: Queue, rules: QueueRules): Promise<Problem[]> {
  const [labels, issues] = await Promise.all([queue.labels(), queue.openIssues()]);
  const problems: Problem[] = [];
  const allowed = new Set(rules.vocabulary);
  const present = new Set(labels.map(({ name }) => name));

  for (const { name } of labels) {
    if (!allowed.has(name)) {
      problems.push({ message: `label '${name}' is outside the queue vocabulary — delete it` });
    }
  }
  for (const name of rules.vocabulary) {
    if (!present.has(name)) problems.push({ message: `label '${name}' is missing from this repo` });
  }

  for (const issue of issues) {
    const carries = issue.labels.some(({ name }) => name === rules.commitmentLabel);
    if (carries && !(issue.body ?? "").includes(TRIGGER)) {
      problems.push({
        message: `issue #${issue.number} is a commitment with no '${TRIGGER}' in its body — a commitment nobody can check is a wish`,
      });
    }
  }

  return problems;
}
