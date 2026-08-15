/** @import { ESTree, SourceCode } from "@oxlint/plugins" */

/** @typedef {ESTree.ArrowFunctionExpression | ESTree.Function} FunctionNode */

/**
 * Every node that opens a scope a local binding's evidence is good for.
 * @param {ESTree.Node} node
 * @returns {node is FunctionNode}
 */
function isFunctionNode(node) {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression"
  );
}

/**
 * @param {ESTree.Expression} expression
 * @returns {ESTree.Expression}
 */
export function unwrapParentheses(expression) {
  let current = expression;
  while (current.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

/**
 * The value under every parenthesis and type-only operator. An assertion,
 * a `satisfies` and a `!` all restate the type of the same expression, so what
 * they wrap is what a rule about where a value came from is asking about.
 * @param {ESTree.Expression} expression
 * @returns {ESTree.Expression}
 */
export function unwrapAssertions(expression) {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The type with its parentheses and `readonly` removed — neither says anything
 * about which type it is.
 * @param {ESTree.TSType} type
 * @returns {ESTree.TSType}
 */
export function unwrapType(type) {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

/**
 * The name a reference names, or nothing when it is qualified (`namespace.Type`)
 * — nothing here can say what a qualified name resolves to.
 * @param {ESTree.TSTypeReference} type
 * @returns {string | null}
 */
export function typeReferenceName(type) {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

/**
 * The function a node sits in. Two rules compare these: evidence established
 * inside one function says nothing about a binding in another, and a parameter's
 * annotation is only evidence for the body it belongs to.
 * @param {ESTree.Node} node
 * @returns {FunctionNode | null}
 */
export function enclosingFunction(node) {
  /** @type {ESTree.Node | null} */
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isFunctionNode(current)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Whether the expression establishes its own type by being written out: a
 * literal, a construction, or an operator over one. Both widening rules ask
 * this, and they have to agree — a value one of them calls known and the other
 * does not is a laundering caught in one spelling and silent in the next.
 * @param {ESTree.Expression} expression
 * @returns {boolean}
 */
export function isKnownEvidenceExpression(expression) {
  const current = unwrapAssertions(expression);
  return (
    current.type === "ObjectExpression" ||
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  );
}

/**
 * What a property is called — the name a reader sees, which is both what a
 * diagnostic has to quote and what a comparison of two property sets is over.
 * A computed key falls back to its source text; the comparison excludes those
 * before it asks, because text is not a name.
 * @param {ESTree.PropertyKey} key
 * @param {SourceCode} sourceCode
 * @returns {string}
 */
export function propertyKeyName(key, sourceCode) {
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
  return key.type === "Literal" ? String(key.value) : sourceCode.getText(key);
}
