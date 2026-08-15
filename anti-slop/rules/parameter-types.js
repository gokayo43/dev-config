/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */
/** @import { TypeEnvironment } from "../shared/types.js" */

import { createTypeEnvironment, resolveType } from "../shared/types.js";

/** @typedef {ESTree.ParamPattern} Parameter */

/**
 * @typedef {ESTree.ArrowFunctionExpression
 *   | ESTree.Function
 *   | ESTree.TSCallSignatureDeclaration
 *   | ESTree.TSConstructSignatureDeclaration
 *   | ESTree.TSConstructorType
 *   | ESTree.TSFunctionType
 *   | ESTree.TSMethodSignature} ParameterOwner
 */

/**
 * The annotation a parameter carries, wherever the pattern put it: a parameter
 * property wraps one, a rest element and a default each hold their own or defer
 * to the binding underneath.
 * @param {Parameter} parameter
 * @returns {ESTree.TSTypeAnnotation | null | undefined}
 */
function parameterAnnotation(parameter) {
  if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter);
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

/**
 * What to call the parameter in the diagnostic. Read through the same patterns,
 * because `cause` behind a default is still the parameter named `cause` — and a
 * destructuring pattern has no name at all, so it is quoted as written, less the
 * annotation being complained about.
 * @param {Parameter} parameter
 * @param {SourceCode} sourceCode
 * @param {string} written
 * @returns {string}
 */
function parameterName(parameter, sourceCode, written) {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceCode, written);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceCode, written);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceCode, written);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceCode.getText(parameter).replace(new RegExp(String.raw`\s*:\s*${written}\s*$`, "u"), "");
}

/**
 * @typedef {object} BannedParameterType
 * @property {string} node The AST type of the annotation this rule refuses.
 * @property {string} written How that type is spelled, for the name fallback above.
 * @property {string} description
 * @property {string} message
 * @property {string} [exemptName] The one parameter name the annotation is a convention on.
 */

/**
 * A rule refusing one broad annotation on a function input. The two below are
 * the same decision over a different keyword: the same ten owners a parameter
 * can belong to, the same walk through the pattern it was written in, and the
 * same question of what its annotation finally resolves to.
 * @param {BannedParameterType} banned
 * @returns {Rule}
 */
function bannedParameterTypeRule(banned) {
  return {
    meta: {
      type: "problem",
      docs: { description: banned.description },
      messages: { bannedParameter: banned.message },
    },
    createOnce(context) {
      /** @type {TypeEnvironment | null} */
      let environment = null;

      /**
       * A union counts: a parameter typed `object | string` accepts everything
       * `object` does, which is the whole of what the rule is about.
       * @param {ESTree.TSType} type
       * @returns {boolean}
       */
      const accepts = (type) => {
        if (environment === null) return false;
        const { type: resolved } = resolveType(type, environment);
        if (resolved.type === banned.node) return true;
        return resolved.type === "TSUnionType" && resolved.types.some(accepts);
      };

      /** @param {ParameterOwner} node */
      const checkParameters = (node) => {
        for (const parameter of node.params) {
          const annotation = parameterAnnotation(parameter);
          if (annotation === null || annotation === undefined) continue;
          if (!accepts(annotation.typeAnnotation)) continue;
          const name = parameterName(parameter, context.sourceCode, banned.written);
          if (name === banned.exemptName) continue;
          context.report({
            node: annotation.typeAnnotation,
            messageId: "bannedParameter",
            data: { parameter: name },
          });
        }
      };

      return {
        Program(node) {
          environment = createTypeEnvironment(node);
        },
        ArrowFunctionExpression: checkParameters,
        FunctionDeclaration: checkParameters,
        FunctionExpression: checkParameters,
        TSCallSignatureDeclaration: checkParameters,
        TSConstructSignatureDeclaration: checkParameters,
        TSConstructorType: checkParameters,
        TSDeclareFunction: checkParameters,
        TSEmptyBodyFunctionExpression: checkParameters,
        TSFunctionType: checkParameters,
        TSMethodSignature: checkParameters,
      };
    },
  };
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = bannedParameterTypeRule({
  node: "TSObjectKeyword",
  written: "object",
  description:
    "Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
  message:
    "Parameter `{{parameter}}` accepts the broad `object` type. Use the expected owner type or decode the external input at its boundary.",
});

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = bannedParameterTypeRule({
  node: "TSUnknownKeyword",
  written: "unknown",
  exemptName: "cause",
  description:
    "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
  message:
    "Parameter `{{parameter}}` accepts `unknown` without establishing its contract. Define the expected schema or parser so the value becomes a strongly typed domain type at the earliest possible point, as close as possible to the I/O boundary where the data originated.",
});
