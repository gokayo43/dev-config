/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import {
  isGlobalNamed,
  isSettledBinding,
  resolveVariable,
  variableDeclarator,
} from "../shared/bindings.js";
import { memberName, propertyKeyName, unwrapAssertions } from "../shared/syntax.js";

/**
 * The `Reflect` method a bare name stands for, when a destructuring took it off
 * the global — `const { apply } = Reflect` leaves a callable that does what
 * `Reflect.apply` does, under a name with no `Reflect` in it.
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {string | null}
 */
function destructuredMethod(sourceCode, identifier) {
  const variable = resolveVariable(sourceCode, identifier);
  const declarator = variable === null ? null : variableDeclarator(variable);
  if (
    variable === null ||
    declarator === null ||
    declarator.init === null ||
    declarator.id.type !== "ObjectPattern" ||
    !isSettledBinding(variable, declarator) ||
    !isGlobalNamed(sourceCode, declarator.init, "Reflect")
  ) {
    return null;
  }

  for (const property of declarator.id.properties) {
    if (property.type !== "Property") continue;
    const bound =
      property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    if (bound.type === "Identifier" && bound.name === identifier.name) {
      return propertyKeyName(property.key, sourceCode);
    }
  }
  return null;
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
      const { sourceCode } = context;

      /**
       * @param {ESTree.Expression} callee
       * @returns {boolean}
       */
      const callsBanned = (callee) => {
        // `memberName` reads both spellings, so `Reflect["get"]` is the same
        // call as `Reflect.get` and neither is a token away from off.
        if (callee.type === "MemberExpression") {
          return (
            memberName(callee) === banned.method &&
            isGlobalNamed(sourceCode, callee.object, "Reflect")
          );
        }
        return (
          callee.type === "Identifier" && destructuredMethod(sourceCode, callee) === banned.method
        );
      };

      return {
        /** @param {ESTree.CallExpression} node */
        CallExpression(node) {
          if (!callsBanned(unwrapAssertions(node.callee))) return;
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
