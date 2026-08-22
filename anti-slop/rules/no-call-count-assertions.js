/** @import { ESTree, Rule } from "@oxlint/plugins" */

import { staticMember } from "../shared/syntax.js";

/**
 * The matchers that grade a collaborator's call log rather than the result of
 * the code under test. Every one of them passes against an implementation that
 * calls the collaborator exactly so and then does nothing with what it got
 * back, and fails against a correct rewrite that batches, caches or reorders —
 * which is the rewrite test read backwards.
 */
const CALL_MATCHERS = new Set([
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledTimes",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
]);

/**
 * `<mock>.mock.calls.length`, spelled from the outside in — the same assertion
 * written by hand, and the spelling a rule that knew only the matchers above
 * would leave as the way through.
 */
const CALL_LOG_LENGTH = ["length", "calls", "mock"];

/**
 * Whether a member chain reads the call log's length: each step named in order
 * from the property outwards.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function readsCallLogLength(node) {
  /** @type {ESTree.Node} */
  let current = node;
  for (const step of CALL_LOG_LENGTH) {
    const member = staticMember(current);
    if (member === null || member.property.name !== step) return false;
    current = member.object;
  }
  return true;
}

/**
 * Refuse assertions about how many times, or in what order, a function was
 * called.
 * @type {Rule}
 */
export const noCallCountAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the call-count and call-order matchers, and the hand-written call-log length beside them.",
    },
    messages: {
      callCount:
        "Assert what the code under test produced or wrote, not its call log ({{matcher}}) — a call log grades the implementation you happen to have, and passes against one that never uses what it got back.",
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        const member = staticMember(node);
        if (member === null) return;
        const { name } = member.property;
        if (CALL_MATCHERS.has(name)) {
          context.report({
            node: member.property,
            messageId: "callCount",
            data: { matcher: name },
          });
          return;
        }
        if (readsCallLogLength(member)) {
          context.report({ node, messageId: "callCount", data: { matcher: "mock.calls.length" } });
        }
      },
    };
  },
};
