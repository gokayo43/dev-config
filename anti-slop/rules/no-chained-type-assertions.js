/** @import { ESTree, Rule } from "@oxlint/plugins" */

/** @typedef {ESTree.TSAsExpression | ESTree.TSTypeAssertion} TypeAssertionExpression */

/**
 * @param {ESTree.Node} node
 * @returns {node is TypeAssertionExpression}
 */
function isTypeAssertionExpression(node) {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

/**
 * @param {ESTree.Expression} expression
 * @returns {ESTree.Expression}
 */
function unwrapParenthesizedExpression(expression) {
  let current = expression;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

/**
 * @param {TypeAssertionExpression} node
 * @returns {boolean}
 */
function isConstAssertion(node) {
  const { typeAnnotation } = node;
  return (
    typeAnnotation.type === "TSTypeReference" &&
    typeAnnotation.typeName.type === "Identifier" &&
    typeAnnotation.typeName.name === "const"
  );
}

/**
 * @param {TypeAssertionExpression} node
 * @returns {boolean}
 */
function isOutermostAssertionInChain(node) {
  /** @type {ESTree.Node} */
  let current = node;
  let parent = node.parent;

  while (parent.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }

  return !isTypeAssertionExpression(parent) || parent.expression !== current;
}

/**
 * @param {TypeAssertionExpression} node
 * @returns {boolean}
 */
function isForbiddenAssertionChain(node) {
  let assertionCount = 0;
  let hasNonConstAssertion = false;
  /** @type {ESTree.Expression} */
  let current = node;

  while (isTypeAssertionExpression(current)) {
    assertionCount += 1;
    hasNonConstAssertion ||= !isConstAssertion(current);
    current = unwrapParenthesizedExpression(current.expression);
  }

  return assertionCount > 1 && hasNonConstAssertion;
}

/**
 * Disallow nested type assertions, while permitting chains made only of const assertions.
 * @type {Rule}
 */
export const noChainedTypeAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow chained TypeScript as and angle-bracket assertions, including parenthesized chains.",
    },
    messages: {
      chained:
        "Chained type assertions discard existing type evidence and fabricate the target type without parsing. Preserve the value's original precise type, or parse genuinely unknown input at its boundary before using it.",
    },
  },
  create(context) {
    /** @param {TypeAssertionExpression} node */
    const checkTypeAssertion = (node) => {
      if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node)) return;
      context.report({ node, messageId: "chained" });
    };

    return {
      TSAsExpression: checkTypeAssertion,
      TSTypeAssertion: checkTypeAssertion,
    };
  },
};
