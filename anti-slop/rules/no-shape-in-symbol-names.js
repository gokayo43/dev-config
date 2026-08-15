/* oxlint-disable anti-slop/no-shape-in-symbol-names -- the one file that has to name the word it bans; spelling its own symbols around the rule is what made them pretend the term was configurable */
/** @import { ESTree, Rule } from "@oxlint/plugins" */

/**
 * @param {string} name
 * @returns {boolean}
 */
function mentionsShape(name) {
  return name.toLowerCase().includes("shape");
}

/**
 * Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name.
 * @type {Rule}
 */
export const noShapeInSymbolNamesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      shapeInName:
        'Do not use the case-insensitive substring "shape" in symbol names (found "{{name}}"). Name the thing by what it is.',
    },
  },
  create(context) {
    /** @param {ESTree.Node & { name: string }} node */
    const reportIfNamedForShape = (node) => {
      if (!mentionsShape(node.name)) return;
      context.report({ node, messageId: "shapeInName", data: { name: node.name } });
    };

    return {
      Identifier: reportIfNamedForShape,
      PrivateIdentifier: reportIfNamedForShape,
      JSXIdentifier: reportIfNamedForShape,
    };
  },
};
