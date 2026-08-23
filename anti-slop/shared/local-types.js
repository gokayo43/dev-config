/** @import { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins" */

/**
 * A name bound below the top level, as far as reading it further can go: the
 * local `type X = …` whose body it stands for, or `OPAQUE` for one there is no
 * single body to read — a type parameter, a mapped type's key, an `infer`, an
 * interface, an enum, a class.
 * @typedef {ESTree.TSTypeAliasDeclaration | typeof OPAQUE | null} LocalType
 */

/** @type {unique symbol} */
export const OPAQUE = Symbol("a local binding with no body to read through");

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
 * What a variable declares, when what it declares is a type.
 * @param {Variable} variable
 * @returns {LocalType}
 */
function declaredType(variable) {
  for (const definition of variable.defs) {
    const declared = definition.node;
    if (declared.type === "TSTypeAliasDeclaration") return declared;
    if (
      declared.type === "TSTypeParameter" ||
      declared.type === "TSMappedType" ||
      declared.type === "TSInterfaceDeclaration" ||
      declared.type === "TSEnumDeclaration" ||
      declared.type === "ClassDeclaration"
    ) {
      return OPAQUE;
    }
  }
  return null;
}

/**
 * What `name`, written at `node`, is bound to below the top level — or nothing,
 * which means the file's own top-level declarations are the answer.
 *
 * Asked of the scope analysis rather than reconstructed from the AST: every
 * rule here that reads a type reference by name resolves it against the file's
 * top-level aliases, and anything declaring that name nearer has taken it.
 * `type Value = unknown` beside `function f<Value>(x: Value)` puts two
 * different `Value`s in one file, and so does a `type Value = string` inside a
 * function body — the analyser is the thing that already knows which is which,
 * with no list of declaration forms here to fall behind.
 *
 * A local `type` answers with its own body, because that body is what the name
 * stands for and reading it is the whole point. The rest answer `OPAQUE`: a
 * parameter has no body at all, and an interface, an enum and a class each have
 * one this walk has nothing to say about.
 *
 * The walk stops at module scope because that is where the top-level
 * declarations are: a name bound there is one of them, not something shadowing
 * one.
 *
 * `infer` is the one binder whose scope is not the answer. TypeScript binds an
 * inferred name in the true branch alone — `Input extends infer Item ? string :
 * Item` leaves the second `Item` as whatever the file declared — while the
 * scope oxc builds for the conditional covers the whole of it.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node} node
 * @param {string} name
 * @returns {LocalType}
 */
export function localTypeBinding(sourceCode, node, name) {
  /** @type {Scope | null} */
  let scope = sourceCode.getScope(node);
  while (scope !== null && scope.type !== "module" && scope.type !== "global") {
    const variable = scope.set.get(name);
    const declared = variable === undefined ? null : declaredType(variable);
    if (variable !== undefined && declared !== null) {
      const conditional = inferredIn(variable);
      const bound =
        conditional === null || descendsThrough(node, conditional, conditional.trueType);
      return bound ? declared : null;
    }
    scope = scope.upper;
  }
  return null;
}
