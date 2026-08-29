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
 * The name a key denotes when it denotes one statically. `a.b`, `a["b"]` and
 * ``a[`b`]`` are one access written three ways, and a rule that knew only the
 * first is one keystroke from silent — so all three answer here. A key computed
 * from a value, and a private field, have no name to give: that is the honest
 * answer rather than a miss, and every caller treats it as "cannot say".
 *
 * A template literal with no substitutions is a spelling, not a computation: it
 * has exactly one value and it is written right there.
 * @param {ESTree.PropertyKey} key
 * @param {boolean} computed
 * @returns {string | null}
 */
function staticName(key, computed) {
  // Written as a name it is one; in brackets the same token is a variable, and
  // a private field is a name no other object can be asked for.
  if (key.type === "Identifier") return computed ? null : key.name;
  if (key.type === "PrivateIdentifier") return null;
  const value = computed ? unwrapAssertions(key) : key;
  if (value.type === "Literal") return typeof value.value === "string" ? value.value : null;
  if (value.type !== "TemplateLiteral" || value.expressions.length > 0) return null;
  return value.quasis[0]?.value.cooked ?? null;
}

/**
 * The property a member reads by name.
 *
 * Every member expression carries the type `"MemberExpression"` whatever the
 * interface holding it is called, and discriminates on `computed`; this is the
 * one place that has to know it.
 * @param {ESTree.Node | null} node
 * @returns {string | null}
 */
export function memberName(node) {
  return node !== null && node.type === "MemberExpression"
    ? staticName(node.property, node.computed)
    : null;
}

/**
 * The key a destructuring reads by name — the same question `memberName` asks
 * of a member expression, over the node an object pattern uses instead.
 * `const { env } = process` and `const { env: renamed } = process` read one
 * property, and the name that says which is the key, never the binding.
 * @param {ESTree.BindingProperty | ESTree.ObjectProperty} property
 * @returns {string | null}
 */
export function patternKeyName(property) {
  return staticName(property.key, property.computed);
}

/**
 * The name a module specifier carries across the boundary: the name the far
 * side exports, not the one this file gives it. Both spellings of it are a
 * `ModuleExportName`, which is an identifier or a string, and the two callers
 * that read one would otherwise each discriminate for themselves.
 * @param {ESTree.ModuleExportName} name
 * @returns {string}
 */
export function moduleExportName(name) {
  return name.type === "Identifier" ? name.name : name.value;
}

/**
 * Whether the value a member expression reads is being written rather than
 * read: assigned to, updated in place, or deleted. One decision, asked of a
 * member by the rules that care which side of an `=` it is on.
 * @param {ESTree.MemberExpression} member
 * @returns {boolean}
 */
export function isWriteTarget(member) {
  const parent = member.parent;
  if (parent.type === "AssignmentExpression") return parent.left === member;
  if (parent.type === "UpdateExpression") return true;
  return parent.type === "UnaryExpression" && parent.operator === "delete";
}

/**
 * The whole property chain a member sits at the bottom of — `process.env.PORT`
 * from the `process.env` in it. A caller asking what is being *done* with a
 * value has to ask it of the outermost read, because that is the one an `=` is
 * on the other side of.
 * @param {ESTree.MemberExpression} member
 * @returns {ESTree.MemberExpression}
 */
export function outermostMember(member) {
  let current = member;
  let above = readOutOf(current);
  while (above !== null) {
    current = above;
    above = readOutOf(current);
  }
  return current;
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
