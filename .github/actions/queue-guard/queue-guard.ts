import type { Problem } from "../_lib/gate.ts";

/** The labels that mean "the product owner approved this". Everything else an agent may set freely. */
const PROMOTIONS = new Set(["ready-for-agent", "ready-for-human"]);

export interface Promotion {
  readonly label: string;
  readonly actor: string;
  readonly owner: string;
  readonly issue: string;
}

/** What the guard does to an issue it is taking a promotion back from. */
export interface IssueDesk {
  comment(issue: string, body: string): Promise<void>;
  removeLabel(issue: string, label: string): Promise<void>;
}

/**
 * Takes the label back rather than reporting it: the run is red *and* the
 * invalid state is gone. Agents file proposals freely and never approve their
 * own, and the labelled event names the actor.
 */
export async function queueGuard(
  { label, actor, owner, issue }: Promotion,
  desk: IssueDesk,
): Promise<Problem[]> {
  if (!PROMOTIONS.has(label) || actor === owner) return [];

  // Explain first, then remove. Whichever of the two a crash lands between, the
  // survivable state is a label with a comment saying it is coming off — a
  // label that vanished without a word is not something anyone can reconstruct.
  await desk.comment(
    issue,
    `Removing \`${label}\`: only @${owner} promotes a proposal, and @${actor} is not @${owner}. Agents file \`needs-triage\` and never approve their own work — this is back with triage.`,
  );
  await desk.removeLabel(issue, label);

  return [
    {
      message: `${actor} added '${label}' — only ${owner} promotes a proposal. The label has been removed and the issue says why.`,
    },
  ];
}
