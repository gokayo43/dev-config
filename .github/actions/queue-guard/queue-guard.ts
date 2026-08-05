import { inputs, type Problem, report } from "../_lib/gate.ts";

/** The labels that mean "the product owner approved this". Everything else an agent may set freely. */
const PROMOTIONS = new Set(["ready-for-agent", "ready-for-human"]);

export function queueGuard(label: string, actor: string, owner: string): Problem[] {
  if (!PROMOTIONS.has(label) || actor === owner) return [];
  return [
    {
      message: `${actor} added '${label}' — only ${owner} promotes a proposal. Agents file needs-triage and never promote their own; remove the label and leave the issue for triage.`,
    },
  ];
}

if (import.meta.main) {
  const read = inputs("label", "actor", "owner");
  report(queueGuard(read["label"], read["actor"], read["owner"]));
}
