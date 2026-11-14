/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { assertionOpening, opensAssertion, runnerApi } from "../shared/runner.js";
import { memberName, unwrapAssertions } from "../shared/syntax.js";

/**
 * The registrations whose callback an emitter calls when the event fires.
 * Nothing in a test waits for that unless it says so, so an assertion in one
 * runs after the case has passed, or never.
 */
const EVENT_REGISTRATIONS = new Set(["on", "once", "addEventListener", "subscribe"]);

/** The matchers any error satisfies when they are given nothing to compare it with. */
const THROW_MATCHERS = new Set(["toThrow", "toThrowError"]);

/** The statements after which nothing in the same block runs. */
const LEAVES = new Set([
  "ReturnStatement",
  "ThrowStatement",
  "ContinueStatement",
  "BreakStatement",
]);
const THROWS = new Set(["ThrowStatement"]);
const RETURNS = new Set(["ReturnStatement"]);

/**
 * Where an assertion stops being one every passing run reaches, named by what
 * lets a run pass without it. `detached` is a function this file cannot see
 * called — a declaration, a stand-in's implementation, a runner's callback —
 * which bounds the question rather than answering it.
 * @typedef {"branch" | "guard" | "catch" | "event" | "detached"} Skip
 */

/**
 * What the rule knows of one file: its source, and every assertion opening in
 * it, which its own visitor collected and whose containment answers "the
 * assertions inside this node".
 * @typedef {{ readonly sourceCode: SourceCode, readonly openings: readonly ESTree.CallExpression[] }} File
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
 * What one step of the climb, from `child` into `parent`, adds to what can let
 * a passing run go without the assertion.
 * @param {File} file
 * @param {ESTree.Node} parent
 * @param {ESTree.Node} child
 * @returns {Skip | null}
 */
function skipAt(file, parent, child) {
  if (parent.type === "IfStatement" || parent.type === "ConditionalExpression") {
    return child === parent.test || otherPathAsserts(file, parent, child) ? null : "branch";
  }
  if (parent.type === "LogicalExpression") return child === parent.right ? "branch" : null;
  if (parent.type === "SwitchCase" && child === parent.test) return null;
  if (parent.type === "SwitchCase") return "branch";
  if (parent.type === "CatchClause") return "catch";
  if (
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "FunctionExpression" ||
    parent.type === "FunctionDeclaration"
  ) {
    return callbackUse(file.sourceCode, parent);
  }
  const statements = statementsOf(parent);
  return statements !== null && guardedBefore(file, statements, child) ? "guard" : null;
}

/**
 * Whether a branch earlier in the block returns on one of its arms without
 * asserting there: `if (!found) return;` above an `expect(found)` lets every
 * run that takes the guard pass without the assertion. A guard that throws
 * fails the run instead, so it is no guard here.
 * @param {File} file
 * @param {readonly ESTree.Node[]} statements
 * @param {ESTree.Node} child
 * @returns {boolean}
 */
function guardedBefore(file, statements, child) {
  const earlier = statements.slice(
    0,
    statements.findIndex((each) => each === child),
  );
  return earlier.some(
    (statement) =>
      statement.type === "IfStatement" &&
      [statement.consequent, statement.alternate].some(
        (arm) =>
          arm !== null && endsIn(arm, RETURNS) && !assertsOnEveryPath(file, [arm], statement),
      ),
  );
}

/**
 * What can let a passing run go without `node`, nearest first, or nothing when
 * every passing run that reaches `top` reaches it too. `top` is a branch, or
 * the block around it, when the question is whether the other path past that
 * branch always asserts, and absent when it is whether the assertion can be
 * skipped at all.
 * @param {File} file
 * @param {ESTree.Node} node
 * @param {ESTree.Node | null} top
 * @returns {Skip | null}
 */
function skipBetween(file, node, top) {
  let child = node;
  let parent = node.parent;
  while (parent !== null && parent !== top) {
    const skip = skipAt(file, parent, child);
    if (skip !== null) return skip;
    child = parent;
    parent = parent.parent;
  }
  return null;
}

/**
 * Whether every passing run down the other path past a branch asserts — the
 * case where the assertion beside it is not one a passing run can do without.
 * The other path is the other arm, which also counts when it always throws,
 * since no run through it passes. Beside an arm that always leaves (`return`,
 * `continue`, `break`, `throw`), the statements after the branch are on the
 * other path too, unless the other arm leaves as well.
 * @param {File} file
 * @param {ESTree.IfStatement | ESTree.ConditionalExpression} branch
 * @param {ESTree.Node} child
 * @returns {boolean}
 */
function otherPathAsserts(file, branch, child) {
  const other = child === branch.consequent ? branch.alternate : branch.consequent;
  // Climbed to the branch rather than to the arm, so an arm that is itself a
  // branch (`else if`) is asked about its own arms on the way.
  if (other !== null && (endsIn(other, THROWS) || assertsOnEveryPath(file, [other], branch))) {
    return true;
  }
  if (!endsIn(child, LEAVES) || (other !== null && endsIn(other, LEAVES))) return false;
  const block = branch.parent;
  const statements = statementsOf(block);
  if (statements === null) return false;
  const after = statements.slice(statements.findIndex((each) => each === branch) + 1);
  return assertsOnEveryPath(file, after, block);
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
 * Whether some assertion inside `nodes` is reached by every passing run that
 * reaches `top`.
 * @param {File} file
 * @param {readonly ESTree.Node[]} nodes
 * @param {ESTree.Node} top
 * @returns {boolean}
 */
function assertsOnEveryPath(file, nodes, top) {
  return nodes.some((node) =>
    file.openings.some(
      (opening) =>
        opening.range[0] >= node.range[0] &&
        opening.range[1] <= node.range[1] &&
        skipBetween(file, opening, top) === null,
    ),
  );
}

/**
 * Whether a statement, or the last statement of a block, is one of `kinds`.
 * @param {ESTree.Node} statement
 * @param {ReadonlySet<string>} kinds
 * @returns {boolean}
 */
function endsIn(statement, kinds) {
  if (statement.type === "BlockStatement") {
    const last = statement.body.at(-1);
    return last !== undefined && endsIn(last, kinds);
  }
  return kinds.has(statement.type);
}

/**
 * Refuse an assertion a passing run can go without: one a branch, a guard that
 * returns, a catch or an event can keep from running, and a throw matcher any
 * error satisfies.
 * @type {Rule}
 */
export const noUnfailableAssertionsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow an expect() a branch, a returning guard, a catch or an event callback can skip, and a throw matcher with nothing to compare.",
    },
    messages: {
      branch:
        "Assert where every passing run reaches, or on every path past the branch — this assertion runs only when the condition lets it, and the case passes having checked nothing when it does not.",
      guard:
        "Fail the case where the guard above returns — throw there, or assert what made it return — since a run that takes that return passes without reaching this assertion.",
      catch:
        "Assert the throw itself, with `expect(() => …).toThrow(<what>)` or `await expect(promise).rejects.toThrow(<what>)` — an assertion in a catch runs only when something throws, so the case passes when nothing does.",
      event:
        "Await the event and assert after it, on a promise its callback settles — nothing waits for this callback, so the case can end before the assertion runs, or without it ever running.",
      bareThrow:
        "Give {{matcher}}() the error it expects, as its class, its message or a pattern — with no argument any error passes, one the code under test never meant to throw included.",
    },
  },
  createOnce(context) {
    /** @type {ESTree.CallExpression[]} */
    let openings = [];
    return {
      before() {
        openings = [];
      },
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        if (opensAssertion(context.sourceCode, node)) openings.push(node);
      },
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        const name = memberName(node);
        if (name === null || !THROW_MATCHERS.has(name)) return;
        const call = node.parent;
        if (call.type !== "CallExpression" || call.callee !== node) return;
        if (call.arguments.length > 0) return;
        const opening = assertionOpening(context.sourceCode, node);
        if (opening === null || opening.negated) return;
        context.report({ node: node.property, messageId: "bareThrow", data: { matcher: name } });
      },
      "Program:exit"() {
        /** @type {File} */
        const file = { sourceCode: context.sourceCode, openings };
        for (const opening of openings) {
          const skip = skipBetween(file, opening, null);
          if (skip === null || skip === "detached") continue;
          context.report({ node: opening, messageId: skip });
        }
      },
    };
  },
};
