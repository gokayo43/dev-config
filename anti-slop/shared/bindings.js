/** @import { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins" */

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
