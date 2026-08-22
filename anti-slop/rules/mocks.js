/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { importedBinding, resolveVariable, settledValue } from "../shared/bindings.js";
import { memberName, propertyKeyName, unwrapAssertions } from "../shared/syntax.js";

/**
 * The modules a stand-in comes out of. Recognition goes through the import
 * rather than the written name, because the written name is the caller's to
 * choose: `import { mock as m }` and `import * as bt` are ordinary style, and a
 * rule keyed to the spelling is one token away from off across the whole fleet.
 */
const RUNNERS = new Set(["bun:test", "vitest", "@jest/globals"]);

/**
 * The names two of the three runners also inject as globals, so a repo
 * configured that way imports nothing. `bun:test` injects none, which is why an
 * unresolved `mock` is somebody else's function rather than a stand-in.
 */
const RUNNER_GLOBALS = new Set(["expect", "jest", "vi"]);

/** The calls that make one, in the vocabulary the three share once the aliases are resolved. */
const STAND_INS = new Set(["mock", "spyOn", "jest.fn", "jest.spyOn", "vi.fn", "vi.spyOn"]);

/** The subset of those that reaches into a value the file did not make. */
const SPIES = new Set(["spyOn", "jest.spyOn", "vi.spyOn"]);

/** Replacing a whole module, under each runner's spelling of it. */
const MODULE_MOCKS = new Set(["mock.module", "jest.mock", "vi.mock"]);

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
function runnerApi(sourceCode, expression) {
  const value = unwrapAssertions(expression);

  if (value.type === "Identifier") {
    const variable = resolveVariable(sourceCode, value);
    const imported = importedBinding(variable);
    if (imported !== null) {
      return RUNNERS.has(imported.source) && imported.name !== "*" ? imported.name : null;
    }
    return variable === null && RUNNER_GLOBALS.has(value.name) ? value.name : null;
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
    if (imported !== null && imported.name === "*") {
      return RUNNERS.has(imported.source) ? name : null;
    }
  }
  const owner = runnerApi(sourceCode, object);
  return owner === null ? null : `${owner}.${name}`;
}

/**
 * What a container written out as a literal holds at that key: `spies.send`
 * where `spies` is `{ send: mock() }`, and `list[0]` where `list` is
 * `[mock()]`. One binding away from where the stand-in was made is as far as
 * this reaches — a `Map`, a factory's return value and a stand-in exported by
 * another file are named limits in the README rather than silent ones.
 * @param {SourceCode} sourceCode
 * @param {ESTree.MemberExpression} member
 * @returns {ESTree.Expression | null}
 */
function heldIn(sourceCode, member) {
  const object = unwrapAssertions(member.object);
  if (object.type !== "Identifier") return null;
  const container = settledValue(sourceCode, object);
  if (container === null) return null;

  if (container.type === "ObjectExpression") {
    const key = memberName(member);
    if (key === null) return null;
    for (const property of container.properties) {
      if (property.type !== "Property" || property.computed) continue;
      if (propertyKeyName(property.key, sourceCode) === key) return property.value;
    }
    return null;
  }

  if (container.type === "ArrayExpression" && member.computed) {
    const index = unwrapAssertions(member.property);
    if (index.type !== "Literal" || typeof index.value !== "number") return null;
    const element = container.elements[index.value];
    return element === null || element === undefined || element.type === "SpreadElement"
      ? null
      : element;
  }

  return null;
}

/**
 * Whether the expression *is* a stand-in rather than one's result: the call
 * that made it, a name holding what that call made, or a slot of a container
 * holding it.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @param {Set<ESTree.Node>} seen
 * @returns {boolean}
 */
function isStandIn(sourceCode, expression, seen) {
  const value = unwrapAssertions(expression);
  // By identity, never by position: `send.mock` and the `send` in it begin at
  // the same offset, so a set of offsets would call the second one already
  // seen. Two `const`s naming each other is a program that never runs, but it
  // is one a linter still has to return from.
  if (seen.has(value)) return false;
  seen.add(value);

  if (value.type === "CallExpression") {
    return STAND_INS.has(runnerApi(sourceCode, value.callee) ?? "");
  }
  if (value.type === "Identifier") {
    const held = settledValue(sourceCode, value);
    return held !== null && isStandIn(sourceCode, held, seen);
  }
  if (value.type === "MemberExpression") {
    const held = heldIn(sourceCode, value);
    return held !== null && isStandIn(sourceCode, held, seen);
  }
  return false;
}

/**
 * Whether the expression is a stand-in or anything reached through one.
 *
 * Two steps outwards, and the difference between them is the whole rule.
 * A property read — `spy.mock`, `spy.mock.calls[0]` — is a read *through* the
 * stand-in, and so is a method called on one of those: `spy.mock.calls.at(0)`
 * is the call log by another spelling. Calling the stand-in itself is not:
 * `send()` is what the code under test would have got, which is the one thing
 * about a stand-in worth asserting on. So a call is stepped through only when
 * it was written on a property, and the stand-in test runs before either step,
 * or `vi.fn()` would be read as a property of `vi`.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} subject
 * @returns {boolean}
 */
function reachesStandIn(sourceCode, subject) {
  /** @type {Set<ESTree.Node>} */
  const seen = new Set();
  let current = unwrapAssertions(subject);
  for (;;) {
    if (isStandIn(sourceCode, current, seen)) return true;
    if (current.type === "MemberExpression") {
      current = unwrapAssertions(current.object);
      continue;
    }
    if (current.type === "CallExpression") {
      const callee = unwrapAssertions(current.callee);
      if (callee.type === "MemberExpression") {
        current = unwrapAssertions(callee.object);
        continue;
      }
    }
    return false;
  }
}

/**
 * The matchers that grade a collaborator's call log rather than the result of
 * the code under test. Every one of them passes against an implementation that
 * calls the collaborator exactly so and then does nothing with what it got
 * back, and fails against a correct rewrite that batches, caches or reorders —
 * which is the rewrite test read backwards.
 */
const CALL_MATCHERS = new Set([
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledTimes",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
]);

/**
 * Whether the matcher hangs off an `expect(…)` — walking back through the
 * members that sit between, which are `.not`, `.resolves` and `.rejects`. The
 * name alone is not the assertion: an object of the test's own with a method
 * called `toHaveBeenCalledTimes` is a counter someone wrote, and refusing it
 * would be this rule grading a name rather than an act.
 * @param {SourceCode} sourceCode
 * @param {ESTree.MemberExpression} matcher
 * @returns {boolean}
 */
function opensAnAssertion(sourceCode, matcher) {
  let current = unwrapAssertions(matcher.object);
  for (;;) {
    if (current.type === "CallExpression") {
      return EXPECTS.has(runnerApi(sourceCode, current.callee) ?? "");
    }
    if (current.type !== "MemberExpression") return false;
    current = unwrapAssertions(current.object);
  }
}

/**
 * Refuse assertions about how many times, or in what order, a function was
 * called.
 * @type {Rule}
 */
export const noCallCountAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the call-count and call-order matchers on an expect() chain.",
    },
    messages: {
      callCount:
        "Assert what the code under test produced or wrote, not its call log ({{matcher}}) — a call log grades the implementation you happen to have, and passes against one that never uses what it got back.",
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        const name = memberName(node);
        if (name === null || !CALL_MATCHERS.has(name)) return;
        if (!opensAnAssertion(context.sourceCode, node)) return;
        context.report({ node: node.property, messageId: "callCount", data: { matcher: name } });
      },
    };
  },
};

/**
 * Refuse `expect(<a stand-in, or anything read out of one>)`.
 * @type {Rule}
 */
export const noMockAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow passing a mock or spy, or anything read through one, to expect().",
    },
    messages: {
      mockAssertion:
        "Assert on what the code under test returned, wrote or threw — a stand-in and everything reachable through it are the test's own, so asserting on them asserts what the test already did.",
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        if (!EXPECTS.has(runnerApi(context.sourceCode, node.callee) ?? "")) return;
        const [subject] = node.arguments;
        if (subject === undefined || subject.type === "SpreadElement") return;
        if (reachesStandIn(context.sourceCode, subject)) {
          context.report({ node: subject, messageId: "mockAssertion" });
        }
      },
    };
  },
};

/**
 * The module a call names, when the source says which one. A string literal and
 * a template with nothing to substitute are the same known string, and a
 * `const` holding one is a name away from it.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @returns {string | null}
 */
function moduleNamed(sourceCode, expression) {
  const value = unwrapAssertions(expression);
  if (value.type === "Literal") return typeof value.value === "string" ? value.value : null;
  if (value.type === "TemplateLiteral") {
    return value.expressions.length === 0 ? (value.quasis[0]?.value.cooked ?? null) : null;
  }
  if (value.type !== "Identifier") return null;
  const held = settledValue(sourceCode, value);
  return held === null || held === value ? null : moduleNamed(sourceCode, held);
}

/**
 * A specifier that can only be a file of ours; a bare one is a package, and a
 * package is the true external boundary a fake belongs at.
 * @param {string} specifier
 * @returns {boolean}
 */
function isOurs(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * The module an expression's value came out of: the import itself, or a `const`
 * holding one. The second step is the same reach the stand-in rules make — a
 * name given to an import once is the import.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @param {Set<ESTree.Node>} seen
 * @returns {string | null}
 */
function importedSource(sourceCode, expression, seen) {
  const value = unwrapAssertions(expression);
  if (value.type !== "Identifier" || seen.has(value)) return null;
  seen.add(value);
  const imported = importedBinding(resolveVariable(sourceCode, value));
  if (imported !== null) return imported.source;
  const held = settledValue(sourceCode, value);
  return held === null ? null : importedSource(sourceCode, held, seen);
}

/**
 * Refuse a stand-in installed over a module this repo wrote.
 * @type {Rule}
 */
export const noLocalModuleMocksRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow mock.module() and spyOn() over a relative import — our own code rather than a package.",
    },
    messages: {
      localMock:
        'Call "{{source}}" for real, or take what it provides as an argument so the test can pass its own — a fake belongs at a true external boundary, and a module in this repo is not one.',
      unnamedModule:
        "Name the module as a string here, so this can tell one of ours from a package — a specifier computed at run time makes the difference unreadable, and the rule refuses rather than guesses in the permissive direction.",
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const { sourceCode } = context;
        const api = runnerApi(sourceCode, node.callee) ?? "";

        if (MODULE_MOCKS.has(api)) {
          const [specifier] = node.arguments;
          if (specifier === undefined || specifier.type === "SpreadElement") return;
          const named = moduleNamed(sourceCode, specifier);
          if (named === null) {
            context.report({ node: specifier, messageId: "unnamedModule" });
          } else if (isOurs(named)) {
            context.report({ node, messageId: "localMock", data: { source: named } });
          }
          return;
        }

        if (!SPIES.has(api)) return;
        const [target] = node.arguments;
        if (target === undefined || target.type === "SpreadElement") return;
        const source = importedSource(sourceCode, target, new Set());
        if (source !== null && isOurs(source)) {
          context.report({ node, messageId: "localMock", data: { source } });
        }
      },
    };
  },
};
