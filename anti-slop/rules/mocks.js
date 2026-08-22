/** @import { ESTree, Rule, SourceCode, Variable } from "@oxlint/plugins" */

import { isSettledBinding, resolveVariable, variableDeclarator } from "../shared/bindings.js";
import { staticMember, unwrapAssertions } from "../shared/syntax.js";

/**
 * What the three runners spell a stand-in with. Written as the source does —
 * `spyOn` is imported bare from `bun:test` and reached through the namespace in
 * the other two — because the callee is what a reader sees and what a rule
 * asking "is this a stand-in" can answer from without a type checker.
 */
const STAND_INS = new Set(["mock", "jest.fn", "vi.fn", "spyOn", "jest.spyOn", "vi.spyOn"]);

/** The three spellings of the one that reaches into a module the file did not write. */
const SPIES = new Set(["spyOn", "jest.spyOn", "vi.spyOn"]);

/**
 * The callee as written: a bare name, or one qualified by a single object. A
 * deeper chain has no name in this vocabulary, which is the honest answer —
 * nothing here can say what `a.b.fn` is.
 * @param {ESTree.Expression} callee
 * @returns {string | null}
 */
function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  const member = staticMember(callee);
  if (member === null) return null;
  const { object, property } = member;
  return object.type === "Identifier" ? `${object.name}.${property.name}` : null;
}

/**
 * Whether the expression *is* a stand-in rather than one's result: the call
 * that made it, or a name holding what that call made.
 * @param {ESTree.Expression} expression
 * @param {SourceCode} sourceCode
 * @returns {boolean}
 */
function isStandIn(expression, sourceCode) {
  const value = unwrapAssertions(expression);
  if (value.type === "CallExpression") return STAND_INS.has(calleeName(value.callee) ?? "");
  if (value.type !== "Identifier") return false;

  const variable = resolveVariable(sourceCode, value);
  if (variable === null) return false;
  const declarator = variableDeclarator(variable);
  if (declarator === null || declarator.init === null) return false;
  // A name the test writes to later is not the call written at its declaration,
  // which is the same evidence rule the widening rules go by.
  if (!isSettledBinding(variable, declarator)) return false;
  const init = unwrapAssertions(declarator.init);
  return init.type === "CallExpression" && STAND_INS.has(calleeName(init.callee) ?? "");
}

/**
 * Refuse `expect(<a stand-in>)`.
 * @type {Rule}
 */
export const noMockAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow passing a mock or spy to expect().",
    },
    messages: {
      mockAssertion:
        "Assert on what the code under test returned, wrote or threw — a stand-in is the test's own object, so asserting on it asserts what the test already did.",
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        if (calleeName(node.callee) !== "expect") return;
        const [subject] = node.arguments;
        if (subject === undefined || subject.type === "SpreadElement") return;
        if (isStandIn(subject, context.sourceCode)) {
          context.report({ node: subject, messageId: "mockAssertion" });
        }
      },
    };
  },
};

/**
 * Whether a name was imported from a path this repo wrote. A relative specifier
 * is the one thing that can only be our own file; a bare one is a package, and
 * a package is a true external boundary where a fake belongs.
 * @param {Variable | null} variable
 * @returns {string | null}
 */
function relativeImportSource(variable) {
  const [definition] = variable?.defs ?? [];
  if (definition?.type !== "ImportBinding") return null;
  const declaration = definition.parent;
  if (declaration === null || declaration.type !== "ImportDeclaration") return null;
  const source = declaration.source.value;
  return source.startsWith("./") || source.startsWith("../") ? source : null;
}

/**
 * The specifier a `mock.module` call replaces, when it is one of ours.
 * @param {ESTree.CallExpression} node
 * @returns {string | null}
 */
function replacedModule(node) {
  if (calleeName(node.callee) !== "mock.module") return null;
  const [specifier] = node.arguments;
  if (specifier?.type !== "Literal" || typeof specifier.value !== "string") return null;
  return specifier.value.startsWith("./") || specifier.value.startsWith("../")
    ? specifier.value
    : null;
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
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const replaced = replacedModule(node);
        if (replaced !== null) {
          context.report({ node, messageId: "localMock", data: { source: replaced } });
          return;
        }

        if (!SPIES.has(calleeName(node.callee) ?? "")) return;
        const [target] = node.arguments;
        if (target?.type !== "Identifier") return;
        const source = relativeImportSource(resolveVariable(context.sourceCode, target));
        if (source !== null) {
          context.report({ node, messageId: "localMock", data: { source } });
        }
      },
    };
  },
};
