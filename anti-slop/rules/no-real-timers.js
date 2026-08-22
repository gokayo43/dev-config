/** @import { ESTree, Reference, Rule, SourceCode } from "@oxlint/plugins" */

import { importedBinding, isEnvironmentDeclared } from "../shared/bindings.js";
import { memberName, readOutOf } from "../shared/syntax.js";

/**
 * The globals that hand a test the wall clock. A suite that waits for real time
 * is slow in proportion to how much of it it waits for and flaky in proportion
 * to how loaded the runner is, and neither shows up as a failing assertion —
 * it shows up as a retry someone added.
 */
const TIMERS = new Set(["setImmediate", "setInterval", "setTimeout"]);

/** Bun's own two, which are members of a global rather than globals. */
const SLEEPS = new Set(["sleep", "sleepSync"]);

/**
 * Every name for the global object. They are one object under four spellings,
 * and a rule that knew only `globalThis` was one word away from silent:
 * `self.setTimeout` is the same function reached the same long way round, and
 * `window` is what a repo with a DOM lib writes without thinking about it.
 */
const HOLDERS = new Set(["global", "globalThis", "self", "window"]);

/**
 * The modules that export the same functions under a name a file can choose.
 * Importing one is not a way round this rule: the promise-shaped `setTimeout`
 * of `node:timers/promises` spends exactly the time the global one does.
 */
const TIMER_MODULES = new Set(["node:timers", "node:timers/promises", "timers"]);

/**
 * The `Bun.sleep` a reference to `Bun` is the `Bun` of, or nothing.
 * @param {ESTree.Node} node
 * @returns {{ at: ESTree.Node, name: string } | null}
 */
function sleepThrough(node) {
  const member = readOutOf(node);
  const name = memberName(member);
  return name !== null && SLEEPS.has(name) ? { at: member ?? node, name: `Bun.${name}` } : null;
}

/**
 * What a reference to a global spends, or nothing. Three shapes reach here and
 * they are the same fact: the bare global, the same global read off
 * `globalThis`, and Bun's sleeps read off either.
 * @param {Reference} reference
 * @returns {{ at: ESTree.Node, name: string } | null}
 */
function spentBy({ identifier }) {
  if (TIMERS.has(identifier.name)) return { at: identifier, name: identifier.name };
  if (identifier.name === "Bun") return sleepThrough(identifier);
  if (!HOLDERS.has(identifier.name)) return null;

  // `globalThis.setTimeout` is the same function reached the long way round,
  // and `globalThis.Bun.sleep` is Bun's the long way round.
  const holder = identifier.name;
  const member = readOutOf(identifier);
  const name = memberName(member);
  if (name === null || member === null) return null;
  if (TIMERS.has(name)) return { at: member, name: `${holder}.${name}` };
  if (name !== "Bun") return null;
  const sleep = sleepThrough(member);
  return sleep === null ? null : { at: sleep.at, name: `${holder}.${sleep.name}` };
}

/**
 * Every reference to something the file did not declare.
 *
 * Two lists, because a global is one of two things to the scope manager: a name
 * nothing resolves, which lands in `through`, or a name resolved to a builtin
 * the environment declares. Which of the two `setTimeout` is depends on the
 * consuming repo's `env` — and `globalThis` is always the second, which is what
 * made reading only `through` a way round this rule. A name the file declares
 * or imports is neither, which is the point: a local `setTimeout` is something
 * else, and a property called `setTimeout` is not a reference at all.
 * @param {SourceCode} sourceCode
 * @returns {readonly Reference[]}
 */
function globalReferences(sourceCode) {
  const global = sourceCode.scopeManager.globalScope;
  if (global === null) return [];
  return [
    ...global.through,
    ...global.variables.filter(isEnvironmentDeclared).flatMap(({ references }) => references),
  ];
}

/**
 * Refuse real time in a test: the timer globals, Bun's two sleeps, and the
 * modules that export the first set under whatever name a file gives them.
 * @type {Rule}
 */
export const noRealTimersRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the timer globals, Bun.sleep, and the node:timers modules, which spend real time.",
    },
    messages: {
      realTimer:
        "Drive virtual time instead of waiting for {{name}} — inject the clock the code reads and advance it, so the test states the interval it is about rather than sleeping through one.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const reference of globalReferences(context.sourceCode)) {
          const spent = spentBy(reference);
          if (spent !== null) {
            context.report({ node: spent.at, messageId: "realTimer", data: { name: spent.name } });
          }
        }

        // And the same functions imported, which resolve and so never reach the
        // loop above. Reported at the import rather than at each use: the
        // import is the decision, and it is the edit that would otherwise turn
        // this rule off for a file by spelling its subject differently.
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            const imported = importedBinding(variable);
            if (imported === null || !TIMER_MODULES.has(imported.source)) continue;
            if (!TIMERS.has(imported.name)) continue;
            const [definition] = variable.defs;
            if (definition === undefined) continue;
            context.report({
              node: definition.name,
              messageId: "realTimer",
              data: { name: `${imported.name} from ${imported.source}` },
            });
          }
        }
      },
    };
  },
};
