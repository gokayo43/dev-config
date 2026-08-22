/** @import { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins" */

/**
 * The two nodes that bind a type name below the top level: a parameter — on a
 * function, an alias, an interface, a class, or an `infer` — and a mapped
 * type's key. A `const` of the same name is neither, and a value and a type
 * sharing a name are two declarations of which only one is this.
 * @param {ESTree.Node} declared
 * @returns {boolean}
 */
function bindsAType(declared) {
  return declared.type === "TSTypeParameter" || declared.type === "TSMappedType";
}

/**
 * @param {ESTree.Node} node
 * @param {ESTree.Node} ancestor
 * @param {ESTree.Node} branch
 * @returns {boolean}
 */
function descendsThrough(node, ancestor, branch) {
  /** @type {ESTree.Node} */
  let descendant = node;
  /** @type {ESTree.Node | null} */
  let current = node.parent;
  while (current !== null && current !== ancestor) {
    descendant = current;
    current = current.parent;
  }
  return current === ancestor && descendant === branch;
}

/**
 * The conditional an `infer` belongs to, which is the nearest one above it.
 * @param {ESTree.Node} inferred
 * @returns {ESTree.TSConditionalType | null}
 */
function conditionalAbove(inferred) {
  /** @type {ESTree.Node | null} */
  let current = inferred;
  while (current !== null) {
    if (current.type === "TSConditionalType") return current;
    current = current.parent;
  }
  return null;
}

/**
 * The conditional whose `infer` bound this name, when one did.
 * @param {Variable} variable
 * @returns {ESTree.TSConditionalType | null}
 */
function inferredIn(variable) {
  for (const definition of variable.defs) {
    const declared = definition.node;
    if (declared.type !== "TSTypeParameter" || declared.parent.type !== "TSInferType") continue;
    return conditionalAbove(declared.parent);
  }
  return null;
}

/**
 * Whether `name`, written at `node`, is a type parameter rather than something
 * the file declared at its top level.
 *
 * Asked of the scope analysis rather than reconstructed from the AST: every
 * rule here that reads a type reference by name resolves it against the file's
 * module-level aliases, and a type parameter takes that name for the whole of
 * the declaration binding it. `type Value = unknown` beside
 * `function f<Value>(x: Value)` puts two different `Value`s in one file, and
 * the analyser is the thing that already knows which is which — for parameters
 * on a function, an alias, an interface or a class, for a mapped type's key,
 * and for `infer`, with no list of node kinds here to fall behind.
 *
 * The walk stops at module scope because that is where the aliases are: a name
 * bound there is the alias, not a parameter shadowing one.
 *
 * `infer` is the one binder whose scope is not the answer. TypeScript binds an
 * inferred name in the true branch alone — `Input extends infer Item ? string :
 * Item` leaves the second `Item` as whatever the file declared — while the
 * scope oxc builds for the conditional covers the whole of it.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node} node
 * @param {string} name
 * @returns {boolean}
 */
export function bindsTypeParameter(sourceCode, node, name) {
  /** @type {Scope | null} */
  let scope = sourceCode.getScope(node);
  while (scope !== null && scope.type !== "module" && scope.type !== "global") {
    const variable = scope.set.get(name);
    if (
      variable !== undefined &&
      variable.defs.some(({ node: declared }) => bindsAType(declared))
    ) {
      const conditional = inferredIn(variable);
      return conditional === null || descendsThrough(node, conditional, conditional.trueType);
    }
    scope = scope.upper;
  }
  return false;
}
