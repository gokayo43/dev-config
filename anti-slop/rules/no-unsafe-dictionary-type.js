/** @import { ESTree, Rule } from "@oxlint/plugins" */
/** @import { TypeEnvironment } from "../shared/dictionary-types.js" */

import {
  classifyUnsafeDictionary,
  classifyUnsafeDictionaryValue,
  createTypeEnvironment,
} from "../shared/dictionary-types.js";

/**
 * @param {ESTree.Node} node
 * @returns {node is ESTree.TSType}
 */
function isTypeNode(node) {
  return node.type.startsWith("TS") && node.type !== "TSTypeAnnotation";
}

/**
 * @param {ESTree.TSTypeReference} type
 * @returns {string | null}
 */
function typeReferenceName(type) {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
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
 * @param {ESTree.TSType} node
 * @param {TypeEnvironment} environment
 * @returns {boolean}
 */
function shouldReportType(node, environment) {
  if (isPlainAliasConsumerUse(node, environment)) return false;
  if (classifyUnsafeDictionary(node, environment) === null) return false;
  let current = node.parent;
  while (current.type !== "Program") {
    if (isTypeNode(current) && classifyUnsafeDictionary(current, environment) !== null)
      return false;
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

    /**
     * @param {ESTree.Node} node
     * @param {string} value
     */
    const report = (node, value) => {
      context.report({ node, messageId: "unsafeDictionary", data: { value } });
    };

    /** @param {ESTree.TSType} node */
    const reportIfUnsafe = (node) => {
      if (environment === null || !shouldReportType(node, environment)) return;
      const unsafe = classifyUnsafeDictionary(node, environment);
      if (unsafe === null) return;
      report(node, unsafe.unsafeValue);
    };

    return {
      Program(node) {
        environment = createTypeEnvironment(node);
      },
      TSTypeReference: reportIfUnsafe,
      TSTypeLiteral: reportIfUnsafe,
      TSMappedType: reportIfUnsafe,
      TSIndexSignature(node) {
        if (environment === null || node.parent.type === "TSTypeLiteral") return;
        const unsafe = classifyUnsafeDictionaryValue(
          node.typeAnnotation.typeAnnotation,
          environment,
        );
        if (unsafe !== null) report(node, unsafe.unsafeValue);
      },
    };
  },
};
