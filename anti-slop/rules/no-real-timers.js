/** @import { ESTree, Rule } from "@oxlint/plugins" */

import { staticMember } from "../shared/syntax.js";

/**
 * The globals that hand a test the wall clock. A suite that waits for real time
 * is slow in proportion to how much of it it waits for and flaky in proportion
 * to how loaded the runner is, and neither shows up as a failing assertion —
 * it shows up as a retry someone added.
 */
const TIMER_GLOBALS = new Set(["setImmediate", "setInterval", "setTimeout"]);

/** Bun's own two, which are members of a global rather than globals. */
const SLEEPS = new Set(["sleep", "sleepSync"]);

/**
 * The `Bun.sleep` this reference is the `Bun` of, or nothing.
 * @param {ESTree.Node} node
 * @returns {ESTree.StaticMemberExpression | ESTree.PrivateFieldExpression | null}
 */
function sleepThrough(node) {
  const member = staticMember(node.parent);
  if (member === null) return null;
  return member.object === node && SLEEPS.has(member.property.name) ? member : null;
}

/**
 * Refuse real time in a test: the timer globals, and Bun's two sleeps.
 * @type {Rule}
 */
export const noRealTimersRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the timer globals and Bun.sleep, which spend real time.",
    },
    messages: {
      realTimer:
        "Drive virtual time instead of waiting for {{name}} — inject the clock the code reads and advance it, so the test states the interval it is about rather than sleeping through one.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        // The references that reached the global scope unresolved, which is
        // what "the global" means: a file that declares or imports its own
        // `setTimeout` is naming something else, and a property called
        // `setTimeout` is not a reference at all.
        const globals = context.sourceCode.scopeManager.globalScope?.through ?? [];
        for (const { identifier } of globals) {
          if (TIMER_GLOBALS.has(identifier.name)) {
            context.report({
              node: identifier,
              messageId: "realTimer",
              data: { name: identifier.name },
            });
            continue;
          }
          if (identifier.name !== "Bun") continue;
          const sleep = sleepThrough(identifier);
          if (sleep !== null) {
            context.report({
              node: sleep,
              messageId: "realTimer",
              data: { name: `Bun.${sleep.property.name}` },
            });
          }
        }
      },
    };
  },
};
