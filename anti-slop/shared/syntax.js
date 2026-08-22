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
 * Whether a node only wraps the value inside it. An assertion, a `satisfies`
 * and a `!` restate its type; a parenthesis restates nothing at all; and a
 * `ChainExpression` says the read may stop short, not that a different value is
 * being read. None of them changes *which* value a rule about provenance is
 * asking about, and both directions of the walk below go by this one list.
 * @param {ESTree.Node} node
 * @returns {node is ESTree.ParenthesizedExpression | ESTree.TSAsExpression | ESTree.TSTypeAssertion | ESTree.TSNonNullExpression | ESTree.TSSatisfiesExpression | ESTree.ChainExpression}
 */
function isValueWrapper(node) {
  return (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  );
}

/**
 * The value under every one of those.
 * @param {ESTree.Expression} expression
 * @returns {ESTree.Expression}
 */
export function unwrapAssertions(expression) {
  let current = expression;
  while (isValueWrapper(current)) current = current.expression;
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
 * The property a member reads by name. `a.b` and `a["b"]` are one access
 * written two ways, and a rule that knew only the first is one keystroke from
 * silent — so both answer here. A key computed from a value, and a private
 * field, have no name to give: that is the honest answer rather than a miss,
 * and every caller treats it as "cannot say".
 *
 * Every member expression carries the type `"MemberExpression"` whatever the
 * interface holding it is called, and discriminates on `computed`; this is the
 * one place that has to know it.
 * @param {ESTree.Node | null} node
 * @returns {string | null}
 */
export function memberName(node) {
  if (node === null || node.type !== "MemberExpression") return null;
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;
  const key = unwrapAssertions(node.property);
  return key.type === "Literal" && typeof key.value === "string" ? key.value : null;
}

/**
 * The member expression a value is read out of — `Bun.sleep` from the `Bun` in
 * it, and from `(Bun as typeof Bun)` or `Bun?` just the same. The climbing twin
 * of `unwrapAssertions`, over the same list, for the rules that start at a
 * resolved reference and have to ask what was done with it.
 * @param {ESTree.Node} node
 * @returns {ESTree.MemberExpression | null}
 */
export function readOutOf(node) {
  let current = node;
  let above = current.parent;
  while (above !== null && isValueWrapper(above)) {
    current = above;
    above = current.parent;
  }
  if (above === null || above.type !== "MemberExpression") return null;
  return above.object === current ? above : null;
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
