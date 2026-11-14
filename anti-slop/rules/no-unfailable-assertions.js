/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { assertionOpening, opensAssertion, runnerApi } from "../shared/runner.js";
import { enclosingFunction, memberName, unwrapAssertions } from "../shared/syntax.js";

/**
 * The registrations whose callback an emitter calls when the event fires.
 * Nothing in a test waits for that unless it says so, so an assertion in one
 * runs after the case has passed, or never.
 */
const EVENT_REGISTRATIONS = new Set(["on", "once", "addEventListener", "subscribe"]);

/** The matchers any error satisfies when they are given nothing to compare it with. */
const THROW_MATCHERS = new Set(["toThrow", "toThrowError"]);

/**
 * The array methods that call what they are given once per element. A `return`
 * in that callback ends one element's turn, as `continue` does in a loop, and
 * neither is reported: whether the collection reaches the assertion is a fact
 * about its values.
 */
const ITERATIONS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

/**
 * How a statement can end: by running on to the next one, by a bare `return;`,
 * by leaving any other way (`return <value>`, a labelled `break` or
 * `continue`), by an unlabelled `break` or `continue` that its loop or
 * `switch` absorbs, or by throwing. Read through blocks, `if`s and loops, where
 * a loop may run no turn at all, so it may always run on. A `switch` or a `try`
 * that holds a `return` or a `throw` is `unreadable`: its fall-through cases
 * and its `finally` decide which of them happens, and the rule answers nothing
 * that rests on it rather than guessing. Any other statement runs on.
 * @typedef {{ readonly fallsThrough: boolean, readonly returnsBare: boolean, readonly leavesOtherwise: boolean, readonly breaks: boolean, readonly throws: boolean, readonly unreadable: boolean }} Ends
 */

/** @type {Ends} */
const RUNS_ON = {
  fallsThrough: true,
  returnsBare: false,
  leavesOtherwise: false,
  breaks: false,
  throws: false,
  unreadable: false,
};

/**
 * @param {Ends} left
 * @param {Ends} right
 * @returns {Ends}
 */
function either(left, right) {
  return {
    fallsThrough: left.fallsThrough || right.fallsThrough,
    returnsBare: left.returnsBare || right.returnsBare,
    leavesOtherwise: left.leavesOtherwise || right.leavesOtherwise,
    breaks: left.breaks || right.breaks,
    throws: left.throws || right.throws,
    unreadable: left.unreadable || right.unreadable,
  };
}

/**
 * The ends of statements run one after another.
 * @param {readonly ESTree.Node[]} statements
 * @returns {Ends}
 */
function endsOfSequence(statements) {
  let ends = RUNS_ON;
  for (const each of statements) {
    const next = endsOf(each);
    ends = { ...either(ends, next), fallsThrough: next.fallsThrough };
    if (!next.fallsThrough) break;
  }
  return ends;
}

/**
 * Whether any path through a statement can leave it other than by running on.
 * @param {Ends} ends
 * @returns {boolean}
 */
function canLeave(ends) {
  return ends.returnsBare || ends.leavesOtherwise || ends.breaks;
}

/**
 * @param {ESTree.Node} statement
 * @returns {Ends}
 */
function endsOf(statement) {
  if (statement.type === "ReturnStatement") {
    return statement.argument === null
      ? { ...RUNS_ON, fallsThrough: false, returnsBare: true }
      : { ...RUNS_ON, fallsThrough: false, leavesOtherwise: true };
  }
  if (statement.type === "ContinueStatement" || statement.type === "BreakStatement") {
    return statement.label === null
      ? { ...RUNS_ON, fallsThrough: false, breaks: true }
      : { ...RUNS_ON, fallsThrough: false, leavesOtherwise: true };
  }
  if (statement.type === "ThrowStatement") return { ...RUNS_ON, fallsThrough: false, throws: true };
  if (statement.type === "IfStatement") {
    return either(
      endsOf(statement.consequent),
      statement.alternate === null ? RUNS_ON : endsOf(statement.alternate),
    );
  }
  if (statement.type === "BlockStatement") return endsOfSequence(statement.body);
  if (isLoop(statement)) {
    return { ...endsOf(statement.body), fallsThrough: true, breaks: false };
  }
  if (statement.type === "SwitchStatement") {
    // An unlabelled `break` is the switch's own, so it alone does not count.
    const inside = statement.cases
      .map((each) => endsOfSequence(each.consequent))
      .reduce(either, RUNS_ON);
    return held({ ...inside, breaks: false });
  }
  if (statement.type === "TryStatement") {
    const parts = [statement.block, statement.handler?.body, statement.finalizer];
    return held(
      parts
        .filter((each) => each !== null && each !== undefined)
        .map(endsOf)
        .reduce(either, RUNS_ON),
    );
  }
  return RUNS_ON;
}

/**
 * @param {ESTree.Node} statement
 * @returns {statement is ESTree.ForStatement | ESTree.ForInStatement | ESTree.ForOfStatement | ESTree.WhileStatement | ESTree.DoWhileStatement}
 */
function isLoop(statement) {
  return (
    statement.type === "ForStatement" ||
    statement.type === "ForInStatement" ||
    statement.type === "ForOfStatement" ||
    statement.type === "WhileStatement" ||
    statement.type === "DoWhileStatement"
  );
}

/**
 * A `switch` or a `try` holding these ends: one that only runs on, or one the
 * rule cannot read.
 * @param {Ends} inside
 * @returns {Ends}
 */
function held(inside) {
  return canLeave(inside) || inside.throws || inside.unreadable
    ? { ...RUNS_ON, unreadable: true }
    : RUNS_ON;
}

/**
 * Whether every path through a statement throws, so no run through it passes.
 * @param {ESTree.Node} statement
 * @returns {boolean}
 */
function alwaysThrows(statement) {
  const ends = endsOf(statement);
  return ends.throws && !ends.fallsThrough && !canLeave(ends) && !ends.unreadable;
}

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
 * Whether a branch earlier in the block can take a bare `return;` without
 * asserting on the way: `if (!found) return;` above an `expect(found)` lets
 * every run that takes the guard pass without the assertion. Three shapes are
 * no guard here: one that throws fails the run instead; a `return <value>`
 * answers a caller the rule cannot see, such as a polling helper retrying on
 * `false`; and one in an array method's callback ends one element's turn, as
 * `continue` does in a loop. Nor is a guard whose condition reads a name an
 * assertion before it in the block already asserts on (`pinnedBefore`).
 * @param {File} file
 * @param {readonly ESTree.Node[]} statements
 * @param {ESTree.Node} child
 * @returns {boolean}
 */
function guardedBefore(file, statements, child) {
  if (inIterationCallback(child)) return false;
  const at = statements.findIndex((each) => each === child);
  return statements
    .slice(0, at)
    .some(
      (statement, index) =>
        statement.type === "IfStatement" &&
        [statement.consequent, statement.alternate].some(
          (arm) =>
            arm !== null &&
            endsOf(arm).returnsBare &&
            !endsOf(arm).unreadable &&
            !assertsOnEveryPath(file, [arm], statement),
        ) &&
        !pinnedBefore(file, statements.slice(0, index), statement.test),
    );
}

/**
 * Whether the nearest function around a node is a callback handed to an array method.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function inIterationCallback(node) {
  const fn = enclosingFunction(node);
  if (fn === null) return false;
  const call = fn.parent;
  if (call.type !== "CallExpression" || !call.arguments.some((each) => each === fn)) return false;
  const name = memberName(unwrapAssertions(call.callee));
  return name !== null && ITERATIONS.has(name);
}

/**
 * Whether an assertion every run reaches among `earlier` takes a subject whose
 * root name (`found` in `expect(found.size)`) is a root name the condition
 * reads. A name match, and no more: a property name never matches, and the
 * rule does not prove the earlier assertion fails on every run the guard would
 * return on.
 * @param {File} file
 * @param {readonly ESTree.Node[]} earlier
 * @param {ESTree.Expression} condition
 * @returns {boolean}
 */
function pinnedBefore(file, earlier, condition) {
  const names = rootNames(file.sourceCode, condition);
  return earlier.some((statement) =>
    file.openings.some((opening) => {
      const [subject] = opening.arguments;
      if (subject === undefined || subject.type === "SpreadElement") return false;
      const root = rootOf(subject);
      return (
        root !== null &&
        names.has(root) &&
        within(opening, statement) &&
        skipBetween(file, opening, statement.parent) === null
      );
    }),
  );
}

/**
 * The name an expression's value is read out of: `found` for `found.size`,
 * `found?.items[0]` and `found.at(0)`, or nothing when it starts elsewhere.
 * @param {ESTree.Expression} expression
 * @returns {string | null}
 */
function rootOf(expression) {
  let current = unwrapAssertions(expression);
  for (;;) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") current = unwrapAssertions(current.object);
    else if (current.type === "CallExpression") current = unwrapAssertions(current.callee);
    else return null;
  }
}

/**
 * The names a node reads as roots, off its tokens: every identifier but one
 * written after `.` or `?.`, which names a property.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node} node
 * @returns {Set<string>}
 */
function rootNames(sourceCode, node) {
  const tokens = sourceCode.getTokens(node);
  return new Set(
    tokens
      .filter(
        (token, index) =>
          token.type === "Identifier" && ![".", "?."].includes(tokens[index - 1]?.value ?? ""),
      )
      .map((token) => token.value),
  );
}

/**
 * @param {ESTree.Node} inner
 * @param {ESTree.Node} outer
 * @returns {boolean}
 */
function within(inner, outer) {
  return inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
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
 * The other path is the other arm, which also counts when every path through
 * it throws, since no run through it passes. Beside an arm no path through
 * which runs on (each leaves by `return`, `continue`, `break` or `throw`), the
 * statements after the branch are on the other path too, as long as no path
 * through the other arm leaves before reaching them.
 * @param {File} file
 * @param {ESTree.IfStatement | ESTree.ConditionalExpression} branch
 * @param {ESTree.Node} child
 * @returns {boolean}
 */
function otherPathAsserts(file, branch, child) {
  const other = child === branch.consequent ? branch.alternate : branch.consequent;
  // Climbed to the branch rather than to the arm, so an arm that is itself a
  // branch (`else if`) is asked about its own arms on the way.
  if (other !== null) {
    // An other arm the rule cannot read may throw on every path, so nothing
    // resting on it is reported.
    if (endsOf(other).unreadable) return true;
    if (alwaysThrows(other) || assertsOnEveryPath(file, [other], branch)) return true;
    if (canLeave(endsOf(other))) return false;
  }
  const holding = endsOf(child);
  if (holding.fallsThrough && !holding.unreadable) return false;
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
      (opening) => within(opening, node) && skipBetween(file, opening, top) === null,
    ),
  );
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
