/** @import { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins" */

import {
  isWriteTarget,
  memberName,
  moduleExportName,
  readOutOf,
  unwrapAssertions,
} from "./syntax.js";

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
 * Whether the environment declared this variable rather than the file.
 *
 * An `env` or `globals` entry in the consuming repo's config resolves to a
 * variable with nothing behind it — the name is in scope, and no line of the
 * file put it there. Which is why a rule cannot read "did this resolve" as
 * "does the file own it": a repo that declares `jest` and `vi` as globals would
 * otherwise turn off every rule keyed to them by writing the config that says
 * it uses them.
 * @param {Variable} variable
 * @returns {boolean}
 */
export function isEnvironmentDeclared(variable) {
  return variable.defs.length === 0;
}

/**
 * Whether a name is the environment's rather than the file's: placed in the
 * global scope, placed nowhere at all, or resolved to one of the above.
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {boolean}
 */
export function isGlobalBinding(sourceCode, identifier) {
  if (sourceCode.isGlobalReference(identifier)) return true;
  const variable = resolveVariable(sourceCode, identifier);
  return variable === null || isEnvironmentDeclared(variable);
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
 *
 * `at` is the local binding the import introduced, which is where a diagnostic
 * about the import belongs. Handed back rather than re-derived, because the
 * caller that went looking for it again had to guard a `defs[0]` this function
 * has already proven is there.
 * @param {Variable | null} variable
 * @returns {{ source: string, name: string, at: ESTree.Node } | null}
 */
export function importedBinding(variable) {
  const [definition] = variable?.defs ?? [];
  if (definition?.type !== "ImportBinding") return null;
  const declaration = definition.parent;
  if (declaration === null || declaration.type !== "ImportDeclaration") return null;

  const specifier = definition.node;
  const source = declaration.source.value;
  const at = definition.name;
  if (specifier.type === "ImportDefaultSpecifier") return { source, name: "default", at };
  if (specifier.type === "ImportNamespaceSpecifier") return { source, name: "*", at };
  if (specifier.type !== "ImportSpecifier") return null;
  return { source, name: moduleExportName(specifier.imported), at };
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
 * Every name for the global object. They are one object under four spellings,
 * and a rule that knew only `globalThis` is one word away from silent:
 * `self.setTimeout` is the same function reached the same long way round,
 * `window` is what a repo with a DOM lib writes without thinking about it, and
 * `global.process.env` is what a Node repo does. One list, because two rules
 * disagreeing about how many names the global object has is a hole in whichever
 * of them knows fewer.
 */
export const GLOBAL_OBJECT_NAMES = new Set(["global", "globalThis", "self", "window"]);

/**
 * Whether an expression is the global of that name, however it was reached: the
 * name itself, the name read off the global object under any of its spellings,
 * or a `const` given one of those once. Recognition goes through the binding
 * rather than the spelling for the reason every rule here does —
 * `globalThis.Reflect` and `const R = Reflect` are one object, and a rule keyed
 * to the written form is one line away from off.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @param {string} name
 * @returns {boolean}
 */
export function isGlobalNamed(sourceCode, expression, name) {
  return denotesGlobal(sourceCode, expression, new Set([name]), new Set());
}

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @param {ReadonlySet<string>} names The names that would answer; several, for the global object itself.
 * @param {Set<ESTree.Node>} seen The aliases already followed, so a name given itself ends the walk.
 * @returns {boolean}
 */
function denotesGlobal(sourceCode, expression, names, seen) {
  const value = unwrapAssertions(expression);

  if (value.type === "MemberExpression") {
    // The only object a global is a property of is the global object, which is
    // itself reached by any of the ways above.
    const read = memberName(value);
    return (
      read !== null &&
      names.has(read) &&
      denotesGlobal(sourceCode, value.object, GLOBAL_OBJECT_NAMES, seen)
    );
  }
  if (value.type !== "Identifier" || seen.has(value)) return false;
  seen.add(value);
  if (names.has(value.name) && isGlobalBinding(sourceCode, value)) return true;
  const held = settledValue(sourceCode, value);
  return held !== null && denotesGlobal(sourceCode, held, names, seen);
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
    return member !== null && isWriteTarget(member);
  });
}
