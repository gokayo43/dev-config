/** @import { ESTree, Rule } from "@oxlint/plugins" */

import { staticMember } from "../shared/syntax.js";

/**
 * The matchers that grade a collaborator's call log rather than the result of
 * the code under test. Every one of them passes against an implementation that
 * calls the collaborator exactly so and then does nothing with what it got
 * back, and fails against a correct rewrite that batches, caches or reorders —
 * which is the rewrite test read backwards.
 *
 * The name is matched wherever it is read, rather than only where it sits
 * directly on an `expect(…)`: `.not`, `.resolves` and `.rejects` each put
 * another member between the two, and a rule that insisted on the shape would
 * be one negation away from silent. Reading the call log by hand is the same
 * assertion and belongs to `no-mock-assertions`, which is the rule that knows
 * what a stand-in is.
 */
const CALL_MATCHERS = new Set([
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledTimes",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
]);

/**
 * Refuse assertions about how many times, or in what order, a function was
 * called.
 * @type {Rule}
 */
export const noCallCountAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the call-count and call-order matchers.",
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
        if (member === null || !CALL_MATCHERS.has(member.property.name)) return;
        context.report({
          node: member.property,
          messageId: "callCount",
          data: { matcher: member.property.name },
        });
      },
    };
  },
};
