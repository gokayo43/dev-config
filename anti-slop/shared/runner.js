/** @import { ESTree, SourceCode } from "@oxlint/plugins" */

import { importedBinding, isGlobalBinding, resolveVariable } from "./bindings.js";
import { memberName, unwrapAssertions } from "./syntax.js";

/**
 * The modules a test runner's API comes out of. Recognition goes through the
 * import rather than the written name, because the written name is the
 * caller's to choose: `import { mock as m }` and `import * as bt` are ordinary
 * style, and a rule keyed to the spelling is one token away from off across the
 * whole fleet.
 */
const RUNNERS = new Set(["bun:test", "vitest", "@jest/globals"]);

/**
 * The names two of the three runners also inject as globals, so a repo
 * configured that way imports nothing. `bun:test` injects none, which is why an
 * unresolved `mock` is somebody else's function rather than a stand-in.
 */
const RUNNER_GLOBALS = new Set(["expect", "jest", "vi"]);

/**
 * The two ways an import names the module rather than an export of it. A star
 * is the obvious one; a default is the same object under Bun's CJS interop, and
 * `import bt from "bun:test"` is what a reader writes when they think it is.
 * Reading only the star made a default import turn the rules off for a file — a
 * one-token edit, and the diff of it is a shortened import line.
 */
const NAMESPACE_NAMES = new Set(["*", "default"]);

/** Every way an assertion is opened. `soft` and `poll` are vitest's, and assert just the same. */
const EXPECTS = new Set(["expect", "expect.soft", "expect.poll"]);

/**
 * Which of the runners' API an expression names, said in the vocabulary above
 * rather than in this file's spelling of it: `m()`, `bt.mock()` and `mock()`
 * all answer `mock`, and `m.module()` answers `mock.module`.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @returns {string | null}
 */
export function runnerApi(sourceCode, expression) {
  const value = unwrapAssertions(expression);

  if (value.type === "Identifier") {
    const variable = resolveVariable(sourceCode, value);
    const imported = importedBinding(variable);
    if (imported !== null) {
      // The namespace itself names no export, and calling it is not a call of
      // one — `bt()` is nothing this rule knows, whichever of the two spellings
      // brought `bt` in.
      const named = RUNNERS.has(imported.source) && !NAMESPACE_NAMES.has(imported.name);
      return named ? imported.name : null;
    }
    return isGlobalBinding(sourceCode, value) && RUNNER_GLOBALS.has(value.name) ? value.name : null;
  }

  if (value.type !== "MemberExpression") return null;
  const name = memberName(value);
  if (name === null) return null;

  // A namespace import is the module itself, so the property read off it is the
  // export — `bt.mock` is `mock`. Every other object is asked what it is first,
  // which is what makes `mock.module` and `expect.soft` reachable at all.
  const object = unwrapAssertions(value.object);
  if (object.type === "Identifier") {
    const imported = importedBinding(resolveVariable(sourceCode, object));
    if (imported !== null && NAMESPACE_NAMES.has(imported.name)) {
      return RUNNERS.has(imported.source) ? name : null;
    }
  }
  const owner = runnerApi(sourceCode, object);
  return owner === null ? null : `${owner}.${name}`;
}

/**
 * Whether a call opens an assertion: `expect(…)` in any spelling the runners
 * give it, recognised through its binding.
 * @param {SourceCode} sourceCode
 * @param {ESTree.CallExpression} call
 * @returns {boolean}
 */
export function opensAssertion(sourceCode, call) {
  return EXPECTS.has(runnerApi(sourceCode, call.callee) ?? "");
}

/**
 * The `expect(…)` a matcher hangs off — walking back through the members that
 * sit between, which are `.not`, `.resolves` and `.rejects` — and whether one
 * of them was `.not`, or nothing. The name alone is not the assertion: an
 * object of the test's own with a method called `toHaveBeenCalledTimes` is a
 * counter someone wrote, and refusing it would be a rule grading a name rather
 * than an act.
 * @param {SourceCode} sourceCode
 * @param {ESTree.MemberExpression} matcher
 * @returns {{ readonly call: ESTree.CallExpression, readonly negated: boolean } | null}
 */
export function assertionOpening(sourceCode, matcher) {
  let negated = false;
  let current = unwrapAssertions(matcher.object);
  for (;;) {
    if (current.type === "CallExpression") {
      return opensAssertion(sourceCode, current) ? { call: current, negated } : null;
    }
    if (current.type !== "MemberExpression") return null;
    if (memberName(current) === "not") negated = true;
    current = unwrapAssertions(current.object);
  }
}
