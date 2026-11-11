/**
 * What switching a rule off looks like in `.oxlintrc.json`, and the reason
 * each switch-off owes above it. The oxlint half of what `reasons.ts` reads,
 * as `tsconfig-flags.ts` is the tsconfig half: the vocabulary of "off" is the
 * config's own, and the reading of a reason is shared.
 */
import { type ConfigFile, isList, type Problem } from "../_lib/gate.ts";
import { type Setting, type Switches, unreasoned } from "./reasons.ts";

/**
 * Whether a rule's or a category's setting switches it off. oxlint's
 * `AllowWarnDeny` documents `"allow"` as the synonym of `"off"` and `0` as the
 * number that means it, each also legal as the head of a list carrying the
 * rule's options.
 */
function silencesRule(value: Setting): boolean {
  const head = isList(value) ? value[0] : value;
  return head === "off" || head === "allow" || head === 0;
}

/**
 * Whether an option switches a body of rules off: `typeAware: false` takes
 * every type-aware rule in the base with it, and `bun run lint` passes no flag
 * that would put them back.
 */
function silencesOption(value: Setting): boolean {
  return value === false;
}

/**
 * The blocks whose members can silence a rule. `overrides` carries no
 * `categories` and no `options` of its own (oxlint's `OxlintOverride`).
 * `globals` and a rule's own options object are why this is a path rather than
 * a key: both hold members whose value is legitimately `"off"` or `false`, and
 * neither silences anything.
 */
const SWITCHES: Switches = new Map([
  ["rules", silencesRule],
  ["overrides.rules", silencesRule],
  ["categories", silencesRule],
  ["options", silencesOption],
]);

/**
 * The reason beside every rule, category and option the config switches off.
 * Tightening a rule or reconfiguring it argues for itself in what it now
 * demands; switching one off argues nothing, and a switch-off with no reason
 * beside it is indistinguishable a year later from one added to get a run
 * green. What counts as the reason, and why a crowded line has none, is
 * `unreasoned`'s. Graded only on a config that parsed, which the lineage check
 * names when it does not.
 */
export function checkOffReasons(oxlintrc: ConfigFile): Problem[] {
  if (oxlintrc.text === undefined) return [];
  return unreasoned(oxlintrc.text, SWITCHES).map(({ name, line, crowded }) => {
    const why = crowded
      ? "shares its line with another entry — one switch-off per line, its reason above"
      : "is turned off with no reason — add the reason above the entry";
    return { file: ".oxlintrc.json", line, message: `${name} ${why}` };
  });
}
