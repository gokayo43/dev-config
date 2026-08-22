/** @import { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins" */

import { readOutOf, unwrapAssertions } from "./syntax.js";

/**
 * The variable an identifier refers to, found by walking out of the scope the
 * identifier appears in — which is what a reference means. The alternative,
 * scanning every scope's references for one at the same source offsets, asks
 * the same question by position and costs a pass over the file per identifier.
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {Variable | null}
 */
export function resolveVariable(sourceCode, identifier) {
  /** @type {Scope | null} */
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * The declarator that introduced a variable, when one declarator did. A name
 * declared more than once has no single initializer to read evidence off, so
 * both rules that ask this want nothing rather than the first of several.
 * @param {Variable} variable
 * @returns {ESTree.VariableDeclarator | null}
 */
export function variableDeclarator(variable) {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

/**
 * Whether the binding's value is the one its declarator gave it: a `const` with
 * an initializer that nothing writes to afterwards. Anything else and the
 * expression written at the declaration is not what the name holds later.
 * @param {Variable} variable
 * @param {ESTree.VariableDeclarator} declarator
 * @returns {boolean}
 */
export function isSettledBinding(variable, declarator) {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    declarator.init !== null &&
    variable.references.every((reference) => reference.init || !reference.isWrite())
  );
}

/**
 * Where a name came from across a module boundary: the specifier it was
 * imported from, and the name it was exported under rather than the one this
 * file happens to call it.
 *
 * That distinction is the whole point. `mock`, `mock as m` and `bt.mock` off a
 * namespace import are one export of one module, and a rule that recognised the
 * written name would be disabled by an `as` — a one-token edit that reads as
 * style. A namespace comes back as `*` and a default as `default`, so a caller
 * can tell the three apart without repeating this walk.
 * @param {Variable | null} variable
 * @returns {{ source: string, name: string } | null}
 */
export function importedBinding(variable) {
  const [definition] = variable?.defs ?? [];
  if (definition?.type !== "ImportBinding") return null;
  const declaration = definition.parent;
  if (declaration === null || declaration.type !== "ImportDeclaration") return null;

  const specifier = definition.node;
  const source = declaration.source.value;
  if (specifier.type === "ImportDefaultSpecifier") return { source, name: "default" };
  if (specifier.type === "ImportNamespaceSpecifier") return { source, name: "*" };
  if (specifier.type !== "ImportSpecifier") return null;
  const imported = specifier.imported;
  const name = imported.type === "Identifier" ? imported.name : imported.value;
  return typeof name === "string" ? { source, name } : null;
}

/**
 * The expression a name was given once and keeps: the initialiser of a `const`
 * nothing writes to afterwards. Anything looser — a `let`, a name declared
 * twice — is not evidence about what the name holds later, which is the rule
 * every binding-reading rule here already goes by.
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {ESTree.Expression | null}
 */
export function settledValue(sourceCode, identifier) {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable === null) return null;
  const declarator = variableDeclarator(variable);
  if (declarator === null || declarator.init === null) return null;
  return isSettledBinding(variable, declarator) ? unwrapAssertions(declarator.init) : null;
}

/**
 * Whether anything writes *through* the binding rather than to it —
 * `spies.send = real`, `delete spies.send`, `spies.count++`.
 *
 * `isSettledBinding` answers for the name; this answers for what the name
 * points at, and only the two together make a literal written at a declaration
 * evidence about a slot later on. A `const` holding an object is still a
 * `const` after every property of it has been replaced.
 * @param {Variable} variable
 * @returns {boolean}
 */
export function writesThroughMember(variable) {
  return variable.references.some(({ identifier }) => {
    const member = readOutOf(identifier);
    if (member === null) return false;
    const parent = member.parent;
    if (parent.type === "AssignmentExpression") return parent.left === member;
    if (parent.type === "UpdateExpression") return true;
    return parent.type === "UnaryExpression" && parent.operator === "delete";
  });
}
