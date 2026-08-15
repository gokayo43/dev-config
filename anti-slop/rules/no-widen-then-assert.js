/** @import { ESTree, Rule, SourceCode, Variable } from "@oxlint/plugins" */

import { isSettledBinding, resolveVariable, variableDeclarator } from "../shared/bindings.js";
import {
  enclosingFunction,
  isKnownEvidenceExpression,
  typeReferenceName,
  unwrapParentheses,
  unwrapType,
} from "../shared/syntax.js";

/** @typedef {"top" | "object" | "record"} BroadTypeKind */

/**
 * @typedef {object} KnownValueEvidence
 * @property {ESTree.TSType | null} type
 */

const ALWAYS_OBJECT_TYPES = new Set([
  "TSArrayType",
  "TSConstructorType",
  "TSFunctionType",
  "TSMappedType",
  "TSObjectKeyword",
  "TSTupleType",
]);

/**
 * @param {ESTree.TSType} type
 * @returns {boolean}
 */
function isUnknownOrAnyType(type) {
  const unwrapped = unwrapType(type);
  return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

/**
 * @param {ESTree.TSType} type
 * @returns {boolean}
 */
function isBroadRecordKeyType(type) {
  const unwrapped = unwrapType(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") return unwrapped.types.every(isBroadRecordKeyType);
  return unwrapped.type === "TSTypeReference" && typeReferenceName(unwrapped) === "PropertyKey";
}

/**
 * The key and value types of a dictionary written out, whichever of the two
 * spellings it was written in. Nothing when the type is not one.
 * @param {ESTree.TSType} type
 * @returns {{ readonly key: ESTree.TSType; readonly value: ESTree.TSType } | null}
 */
function recordParts(type) {
  const unwrapped = unwrapType(type);

  if (unwrapped.type === "TSTypeReference") {
    const parameters = unwrapped.typeArguments?.params ?? [];
    if (typeReferenceName(unwrapped) === "Readonly") {
      const [inner] = parameters;
      return inner === undefined ? null : recordParts(inner);
    }
    if (typeReferenceName(unwrapped) !== "Record" || parameters.length !== 2) return null;
    const [key, value] = parameters;
    return key === undefined || value === undefined ? null : { key, value };
  }

  if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) return null;
  const [member] = unwrapped.members;
  if (member?.type !== "TSIndexSignature" || member.parameters.length !== 1) return null;
  const [parameter] = member.parameters;
  return parameter === undefined
    ? null
    : { key: parameter.typeAnnotation.typeAnnotation, value: member.typeAnnotation.typeAnnotation };
}

/**
 * How a target type is broad, when it is. A dictionary counts only when its
 * value type is a top type as well — `Record<string, Command>` still says what
 * it holds, and asserting a key out of one erases nothing.
 * @param {ESTree.TSType} type
 * @returns {BroadTypeKind | null}
 */
function broadTypeKind(type) {
  const unwrapped = unwrapType(type);
  if (unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword") return "top";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  const parts = recordParts(unwrapped);
  return parts !== null && isBroadRecordKeyType(parts.key) && isUnknownOrAnyType(parts.value)
    ? "record"
    : null;
}

/**
 * @param {ESTree.TSAsExpression | ESTree.TSTypeAssertion} node
 * @returns {ESTree.Expression}
 */
function assertedExpression(node) {
  return unwrapParentheses(node.expression);
}

/**
 * @param {ESTree.Expression} expression
 * @returns {ESTree.TSAsExpression | ESTree.TSTypeAssertion | null}
 */
function assertionFromExpression(expression) {
  const unwrapped = unwrapParentheses(expression);
  return unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion"
    ? unwrapped
    : null;
}

/**
 * @param {string} sourceText
 * @param {ESTree.TSType} type
 * @returns {string}
 */
function normalizedTypeText(sourceText, type) {
  return sourceText.slice(type.start, type.end).replaceAll(/\s+/gu, "");
}

/**
 * @param {string} sourceText
 * @param {ESTree.TSType | null} left
 * @param {ESTree.TSType} right
 * @returns {boolean}
 */
function typesHaveSameSyntax(sourceText, left, right) {
  return (
    left !== null &&
    normalizedTypeText(sourceText, unwrapType(left)) ===
      normalizedTypeText(sourceText, unwrapType(right))
  );
}

/**
 * @param {ESTree.TSType} type
 * @returns {boolean}
 */
function isDefinitelyObjectType(type) {
  const unwrapped = unwrapType(type);
  if (ALWAYS_OBJECT_TYPES.has(unwrapped.type)) return true;
  if (unwrapped.type === "TSTypeLiteral") return unwrapped.members.length > 0;
  return unwrapped.type === "TSIntersectionType" && unwrapped.types.every(isDefinitelyObjectType);
}

/**
 * @param {ESTree.TSType} type
 * @returns {boolean}
 */
function isDefinitelyNarrowerRecordType(type) {
  const unwrapped = unwrapType(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type !== "TSIndexSignature");
  }
  const parts = recordParts(unwrapped);
  return parts !== null && !isUnknownOrAnyType(parts.value);
}

/**
 * The evidence a variable's own declaration carries, when the declaration is in
 * the same function the assertion is: a type it was annotated with, or the
 * expression it was initialised from, followed through further settled bindings.
 * @param {Variable} variable
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node | null} boundary
 * @param {ReadonlySet<Variable>} visitedVariables
 * @returns {KnownValueEvidence | null}
 */
function evidenceFromVariable(variable, sourceCode, boundary, visitedVariables) {
  const annotated = variable.identifiers.find(
    (identifier) => identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined,
  );
  const annotation = annotated?.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined && annotated !== undefined) {
    return enclosingFunction(annotated) !== boundary || broadTypeKind(annotation) !== null
      ? null
      : { type: annotation };
  }

  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.init === null ||
    !isSettledBinding(variable, declarator) ||
    enclosingFunction(declarator) !== boundary
  ) {
    return null;
  }
  return knownValueEvidence(
    declarator.init,
    sourceCode,
    boundary,
    new Set([...visitedVariables, variable]),
  );
}

/**
 * @param {ESTree.Expression} expression
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node | null} boundary
 * @param {ReadonlySet<Variable>} visitedVariables
 * @returns {KnownValueEvidence | null}
 */
function knownValueEvidence(expression, sourceCode, boundary, visitedVariables) {
  const unwrapped = unwrapParentheses(expression);

  if (unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion") {
    return broadTypeKind(unwrapped.typeAnnotation) === null
      ? { type: unwrapped.typeAnnotation }
      : null;
  }
  if (isKnownEvidenceExpression(unwrapped)) return { type: null };
  if (unwrapped.type !== "Identifier") return null;

  const variable = resolveVariable(sourceCode, unwrapped);
  return variable === null || visitedVariables.has(variable)
    ? null
    : evidenceFromVariable(variable, sourceCode, boundary, visitedVariables);
}

/**
 * @param {Variable} variable
 * @param {SourceCode} sourceCode
 * @returns {{
 *   readonly broadKind: BroadTypeKind;
 *   readonly evidence: KnownValueEvidence;
 *   readonly declaredAt: number;
 *   readonly boundary: ESTree.Node | null;
 * } | null}
 */
function widenedBinding(variable, sourceCode) {
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    !isSettledBinding(variable, declarator)
  ) {
    return null;
  }

  const boundary = enclosingFunction(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null ? null : broadTypeKind(initializerAssertion.typeAnnotation);
  const declaredBroadKind = declaredType === undefined ? null : broadTypeKind(declaredType);
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) return null;

  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? assertedExpression(initializerAssertion)
      : declarator.init;
  const evidence = knownValueEvidence(
    originalExpression,
    sourceCode,
    boundary,
    new Set([variable]),
  );
  return evidence === null ? null : { broadKind, evidence, declaredAt: declarator.end, boundary };
}

/**
 * @param {string} sourceText
 * @param {BroadTypeKind} broadKind
 * @param {KnownValueEvidence} evidence
 * @param {ESTree.TSType} assertedType
 * @returns {boolean}
 */
function assertionIsNarrower(sourceText, broadKind, evidence, assertedType) {
  if (broadTypeKind(assertedType) !== null) return false;
  if (broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
  if (broadKind === "object") return isDefinitelyObjectType(assertedType);
  return isDefinitelyNarrowerRecordType(assertedType);
}

/**
 * Detect immutable local bindings that erase a known type and are later asserted back to a narrower type.
 * @type {Rule}
 */
export const noWidenThenAssertRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" erases established type evidence by widening the value, then reconstructs that evidence with a type assertion. Preserve the precise type end-to-end; if the input is genuinely unknown, parse it once at the boundary instead.',
    },
  },
  create(context) {
    /** @param {ESTree.TSAsExpression | ESTree.TSTypeAssertion} node */
    const checkAssertion = (node) => {
      const expression = assertedExpression(node);
      if (expression.type !== "Identifier") return;

      const variable = resolveVariable(context.sourceCode, expression);
      if (variable === null) return;
      const widened = widenedBinding(variable, context.sourceCode);
      if (
        widened === null ||
        node.start <= widened.declaredAt ||
        enclosingFunction(node) !== widened.boundary ||
        !assertionIsNarrower(
          context.sourceCode.text,
          widened.broadKind,
          widened.evidence,
          node.typeAnnotation,
        )
      ) {
        return;
      }

      context.report({ node, messageId: "widenThenAssert", data: { name: expression.name } });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};
