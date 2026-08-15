/** @import { ESTree, Rule } from "@oxlint/plugins" */

const FORBIDDEN_SYMBOL_NAME = "shape";

/**
 * @param {string} name
 * @returns {boolean}
 */
function containsForbiddenSymbolName(name) {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/**
 * Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name.
 * @type {Rule}
 */
export const noForbiddenTermInSymbolNamesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Do not use the case-insensitive substring "shape" in symbol names (found "{{name}}"). Name the thing by what it is.',
    },
  },
  create(context) {
    /** @param {ESTree.Node & { name: string }} node */
    const reportForbiddenSymbolName = (node) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
};
