/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { assertionOpening, EXPECTS, runnerApi } from "../shared/runner.js";
import { memberName, unwrapAssertions } from "../shared/syntax.js";

/**
 * The registrations whose callback an emitter calls when the event fires.
 * Nothing in a test waits for that unless it says so, so an assertion in one
 * runs after the case has passed, or never.
 */
const EVENT_REGISTRATIONS = new Set(["on", "once", "addEventListener", "subscribe"]);

/** The matchers any error satisfies when they are given nothing to compare it with. */
const THROW_MATCHERS = new Set(["toThrow", "toThrowError"]);

/**
 * Where an assertion stops being one that always runs, named by what makes it
 * skippable. `detached` is a function this file cannot see called — a
 * declaration, a stand-in's implementation, a runner's callback — which bounds
 * the question rather than answering it.
 * @typedef {"branch" | "catch" | "event" | "detached"} Skip
 */

/**
 * Whether a runner call is what the function is handed to: `test(…)`,
 * `test.each(table)(…)`, `describe.skip(…)`, `mock(…)`, `expect(…)`. A test is
 * the unit an assertion belongs to, so the climb stops there; a test the file
 * registers only on some runs is a skipped test, which the run's own report
 * counts, and not an assertion a run skips inside a test.
 * @param {SourceCode} sourceCode
 * @param {ESTree.CallExpression} call
 * @returns {boolean}
 */
function isRunnerCall(sourceCode, call) {
  let current = unwrapAssertions(call.callee);
  for (;;) {
    if (runnerApi(sourceCode, current) !== null) return true;
    if (current.type === "CallExpression") current = unwrapAssertions(current.callee);
    else if (current.type === "MemberExpression") current = unwrapAssertions(current.object);
    else return false;
  }
}

/**
 * What the code around a function does with it, which is all a rule reading one
 * file can know about whether its body runs. Handed as an argument to anything
 * else — `.then`, `.finally`, a retry helper, `fc.property`, an array method —
 * it runs when that call does, and the climb goes on past the call.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Function | ESTree.ArrowFunctionExpression} fn
 * @returns {Skip | null}
 */
function callbackUse(sourceCode, fn) {
  const call = fn.parent;
  if (call.type !== "CallExpression" || !call.arguments.some((each) => each === fn)) {
    return "detached";
  }
  const callee = unwrapAssertions(call.callee);
  const name = callee.type === "Identifier" ? callee.name : memberName(callee);
  // `.then`'s second argument is the rejection handler `.catch` would be given.
  if (name === "catch" || (name === "then" && call.arguments[1] === fn)) return "catch";
  if (name !== null && EVENT_REGISTRATIONS.has(name)) return "event";
  return isRunnerCall(sourceCode, call) ? "detached" : null;
}

/**
 * What one step of the climb, from `child` into `parent`, adds to what can keep
 * an assertion from running.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node} parent
 * @param {ESTree.Node} child
 * @returns {Skip | null}
 */
function skipAt(sourceCode, parent, child) {
  if (parent.type === "IfStatement" || parent.type === "ConditionalExpression") {
    return child === parent.test || otherArmAsserts(sourceCode, parent, child) ? null : "branch";
  }
  if (parent.type === "LogicalExpression") return child === parent.right ? "branch" : null;
  if (parent.type === "SwitchCase") return child === parent.test ? null : "branch";
  if (parent.type === "CatchClause") return "catch";
  if (
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "FunctionExpression" ||
    parent.type === "FunctionDeclaration"
  ) {
    return callbackUse(sourceCode, parent);
  }
  return null;
}

/**
 * What can keep `node` from running whenever `top` does, nearest first, or
 * nothing when it always runs with it. `top` is a branch when the question is
 * whether one of its arms always asserts, and absent when it is whether the
 * assertion can be skipped at all.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node} node
 * @param {ESTree.Node | null} top
 * @returns {Skip | null}
 */
function skipBetween(sourceCode, node, top) {
  let child = node;
  let parent = node.parent;
  while (parent !== null && parent !== top) {
    const skip = skipAt(sourceCode, parent, child);
    if (skip !== null) return skip;
    child = parent;
    parent = parent.parent;
  }
  return null;
}

/**
 * Whether the other path past a branch asserts on every run through it — the
 * case where one of the two always runs, so neither is a skipped assertion.
 * The other path is the other arm, or, beside an arm that always leaves
 * (`return`, `continue`, `break`, `throw`), the statements after the branch.
 * @param {SourceCode} sourceCode
 * @param {ESTree.IfStatement | ESTree.ConditionalExpression} branch
 * @param {ESTree.Node} child
 * @returns {boolean}
 */
function otherArmAsserts(sourceCode, branch, child) {
  const other = child === branch.consequent ? branch.alternate : branch.consequent;
  // Climbed to the branch rather than to the arm, so an arm that is itself a
  // branch (`else if`) is asked about its own arms on the way.
  if (other !== null) return assertsOnEveryPath(sourceCode, [other], branch);
  const block = branch.parent;
  const statements = statementsOf(block);
  if (statements === null || !alwaysLeaves(child)) return false;
  const after = statements.slice(statements.findIndex((each) => each === branch) + 1);
  return assertsOnEveryPath(sourceCode, after, block);
}

/**
 * The statement list a node holds, where it holds one.
 * @param {ESTree.Node} node
 * @returns {readonly ESTree.Node[] | null}
 */
function statementsOf(node) {
  if (node.type === "BlockStatement" || node.type === "Program" || node.type === "StaticBlock") {
    return node.body;
  }
  return node.type === "SwitchCase" ? node.consequent : null;
}

/**
 * Whether some assertion among `nodes` runs whenever `top` does.
 * @param {SourceCode} sourceCode
 * @param {readonly ESTree.Node[]} nodes
 * @param {ESTree.Node} top
 * @returns {boolean}
 */
function assertsOnEveryPath(sourceCode, nodes, top) {
  return nodes.some((node) =>
    assertionsIn(sourceCode, node).some(
      (opening) => skipBetween(sourceCode, opening, top) === null,
    ),
  );
}

/**
 * Whether a statement never falls through to the one after it.
 * @param {ESTree.Node} statement
 * @returns {boolean}
 */
function alwaysLeaves(statement) {
  if (statement.type === "BlockStatement") {
    const last = statement.body.at(-1);
    return last !== undefined && alwaysLeaves(last);
  }
  return (
    statement.type === "ReturnStatement" ||
    statement.type === "ThrowStatement" ||
    statement.type === "ContinueStatement" ||
    statement.type === "BreakStatement"
  );
}

/**
 * Every `expect(…)` written inside a node, in any function under it: the climb
 * from each is what decides whether it counts.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node} node
 * @returns {ESTree.CallExpression[]}
 */
function assertionsIn(sourceCode, node) {
  /** @type {ESTree.CallExpression[]} */
  const found = [];
  /** @param {unknown} value */
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const each of value) visit(each);
      return;
    }
    if (typeof value !== "object" || value === null || !("type" in value)) return;
    const current = /** @type {ESTree.Node} */ (value);
    if (current.type === "CallExpression" && opensAssertion(sourceCode, current)) {
      found.push(current);
    }
    for (const [key, child] of Object.entries(current)) {
      if (key !== "parent") visit(child);
    }
  };
  visit(node);
  return found;
}

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.CallExpression} call
 * @returns {boolean}
 */
function opensAssertion(sourceCode, call) {
  return EXPECTS.has(runnerApi(sourceCode, call.callee) ?? "");
}

/**
 * Whether a matcher is negated anywhere between it and the `expect(…)` it hangs
 * off. `.not.toThrow()` with nothing to compare is exactly what it should be.
 * @param {ESTree.MemberExpression} matcher
 * @param {ESTree.CallExpression} opening
 * @returns {boolean}
 */
function isNegated(matcher, opening) {
  let current = unwrapAssertions(matcher.object);
  while (current !== opening && current.type === "MemberExpression") {
    if (memberName(current) === "not") return true;
    current = unwrapAssertions(current.object);
  }
  return false;
}

/**
 * Refuse an assertion that passes whatever the code under test does: one a
 * branch, a catch or an event can keep from running, and a throw matcher any
 * error satisfies.
 * @type {Rule}
 */
export const noUnfailableAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow an expect() a branch, a catch or an event callback can skip, and a throw matcher with nothing to compare.",
    },
    messages: {
      branch:
        "Assert where every run reaches, or in every arm of the branch — this assertion runs only when the condition lets it, and the case passes having checked nothing when it does not.",
      catch:
        "Assert the throw itself, with `expect(() => …).toThrow(<what>)` or `await expect(promise).rejects.toThrow(<what>)` — an assertion in a catch runs only when something throws, so the case passes when nothing does.",
      event:
        "Await the event and assert after it, on a promise its callback settles — nothing waits for this callback, so the case can end before the assertion runs, or without it ever running.",
      bareThrow:
        "Give {{matcher}}() the error it expects, as its class, its message or a pattern — with no argument any error passes, one the code under test never meant to throw included.",
    },
  },
  createOnce(context) {
    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const { sourceCode } = context;
        if (!opensAssertion(sourceCode, node)) return;
        const skip = skipBetween(sourceCode, node, null);
        if (skip === null || skip === "detached") return;
        context.report({ node, messageId: skip });
      },
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        const name = memberName(node);
        if (name === null || !THROW_MATCHERS.has(name)) return;
        const call = node.parent;
        if (call.type !== "CallExpression" || call.callee !== node) return;
        if (call.arguments.length > 0) return;
        const opening = assertionOpening(context.sourceCode, node);
        if (opening === null || isNegated(node, opening)) return;
        context.report({ node: node.property, messageId: "bareThrow", data: { matcher: name } });
      },
    };
  },
};
