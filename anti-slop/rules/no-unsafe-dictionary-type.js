/** @import { ESTree, Rule } from "@oxlint/plugins" */
/** @import { TypeParameterScopes } from "../shared/type-parameters.js" */
/** @import { TypeEnvironment } from "../shared/types.js" */

import { typeReferenceName } from "../shared/syntax.js";
import { createTypeParameterScopes } from "../shared/type-parameters.js";
import {
  classifyUnsafeDictionary,
  classifyUnsafeDictionaryValue,
  createTypeEnvironment,
} from "../shared/types.js";

/**
 * @param {ESTree.Node} node
 * @returns {node is ESTree.TSType}
 */
function isTypeNode(node) {
  return node.type.startsWith("TS") && node.type !== "TSTypeAnnotation";
}

/**
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isInsideTypeAliasDeclaration(node) {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (current.type === "TSTypeAliasDeclaration") return true;
    current = current.parent;
  }
  return false;
}

/**
 * @param {ESTree.TSType} node
 * @param {TypeEnvironment} environment
 * @returns {boolean}
 */
function isPlainAliasConsumerUse(node, environment) {
  if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
  const name = typeReferenceName(node);
  return name !== null && environment.aliases.has(name) && !isInsideTypeAliasDeclaration(node);
}

/**
 * Each type is asked with the binders in scope where it sits, not where the
 * innermost one does: an enclosing type is outside any parameter the inner
 * declaration introduced, and reading it under the inner set would let a name
 * bound below silence a dictionary written above.
 * @param {ESTree.TSType} node
 * @param {TypeEnvironment} environment
 * @param {TypeParameterScopes} scopes
 * @returns {boolean}
 */
function shouldReportType(node, environment, scopes) {
  if (isPlainAliasConsumerUse(node, environment)) return false;
  if (classifyUnsafeDictionary(node, environment, scopes.at(node)) === null) return false;
  let current = node.parent;
  while (current.type !== "Program") {
    if (
      isTypeNode(current) &&
      classifyUnsafeDictionary(current, environment, scopes.at(current)) !== null
    ) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

/**
 * Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch.
 * @type {Rule}
 */
export const noUnsafeDictionaryTypeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
    },
    messages: {
      unsafeDictionary:
        "This object dictionary's direct value type is an unsafe {{value}} escape hatch. Replace it with a concrete owner/schema-derived value type and parse external data at its boundary.",
    },
  },
  createOnce(context) {
    /** @type {TypeEnvironment | null} */
    let environment = null;
    const scopes = createTypeParameterScopes();

    /**
     * @param {ESTree.Node} node
     * @param {string} value
     */
    const report = (node, value) => {
      context.report({ node, messageId: "unsafeDictionary", data: { value } });
    };

    /** @param {ESTree.TSType} node */
    const reportIfUnsafe = (node) => {
      if (environment === null || !shouldReportType(node, environment, scopes)) return;
      const unsafe = classifyUnsafeDictionary(node, environment, scopes.at(node));
      if (unsafe === null) return;
      report(node, unsafe.unsafeValue);
    };

    return {
      Program(node) {
        environment = createTypeEnvironment(node);
        scopes.reset();
      },
      TSInferType: scopes.record,
      TSTypeReference: reportIfUnsafe,
      TSTypeLiteral: reportIfUnsafe,
      TSMappedType: reportIfUnsafe,
      TSIndexSignature(node) {
        if (environment === null || node.parent.type === "TSTypeLiteral") return;
        const unsafe = classifyUnsafeDictionaryValue(
          node.typeAnnotation.typeAnnotation,
          environment,
          scopes.at(node),
        );
        if (unsafe !== null) report(node, unsafe.unsafeValue);
      },
    };
  },
};
