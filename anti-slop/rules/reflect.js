/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { resolveVariable } from "../shared/bindings.js";
import { memberName, unwrapAssertions } from "../shared/syntax.js";

/**
 * Whether an expression is the global `Reflect` rather than something a file
 * named after it. A local binding of that name is somebody else's object, and a
 * rule that reads the spelling alone reports their code.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @returns {boolean}
 */
function isGlobalReflect(sourceCode, expression) {
  const value = unwrapAssertions(expression);
  if (value.type !== "Identifier" || value.name !== "Reflect") return false;
  if (sourceCode.isGlobalReference(value)) return true;
  // A name resolved to nothing, or to a variable nothing declares, is the
  // global: `isGlobalReference` answers no for a reference the scope analysis
  // could not place, and every one of those in a file that never declares
  // `Reflect` is the built-in.
  const variable = resolveVariable(sourceCode, value);
  return variable === null || variable.defs.length === 0;
}

/**
 * @typedef {object} BannedReflectMethod
 * @property {string} method The method on the global `Reflect` this rule refuses.
 * @property {string} description
 * @property {string} message
 */

/**
 * A rule refusing one method on the global `Reflect`. The two below are the
 * same decision over a different name: both launder past the thing the type
 * system was going to check — the call and the property read — and both answer
 * a type nobody wrote down.
 * @param {BannedReflectMethod} banned
 * @returns {Rule}
 */
function bannedReflectMethodRule(banned) {
  return {
    meta: {
      type: "problem",
      docs: { description: banned.description },
      messages: { bannedReflect: banned.message },
    },
    create(context) {
      return {
        /** @param {ESTree.CallExpression} node */
        CallExpression(node) {
          const callee = unwrapAssertions(node.callee);
          // `memberName` reads both spellings, so `Reflect["get"]` is the same
          // call as `Reflect.get` and neither is a token away from off.
          if (callee.type !== "MemberExpression" || memberName(callee) !== banned.method) return;
          if (!isGlobalReflect(context.sourceCode, callee.object)) return;
          context.report({ node, messageId: "bannedReflect" });
        },
      };
    },
  };
}

/** Ban Reflect.apply, which bypasses ordinary typed function calls. */
export const noReflectApplyRule = bannedReflectMethodRule({
  method: "apply",
  description:
    "Disallow Reflect.apply; call typed functions directly or model dynamic dispatch behind an interface.",
  message:
    "Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
});

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = bannedReflectMethodRule({
  method: "get",
  description:
    "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
  message:
    "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
});
