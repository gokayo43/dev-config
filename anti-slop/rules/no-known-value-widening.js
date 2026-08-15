/** @import { ESTree, Rule, SourceCode, Variable } from "@oxlint/plugins" */
/** @import { FunctionNode } from "../shared/syntax.js" */
/** @import { TypeEnvironment, WideningTarget } from "../shared/types.js" */

import { isSettledBinding, resolveVariable, variableDeclarator } from "../shared/bindings.js";
import {
  enclosingFunction,
  isKnownEvidenceExpression,
  propertyKeyName,
  unwrapAssertions,
} from "../shared/syntax.js";
import { classifyWideningTarget, createTypeEnvironment } from "../shared/types.js";

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @param {Set<Variable>} [visitedVariables]
 * @returns {boolean}
 */
function hasKnownEvidence(sourceCode, expression, visitedVariables = new Set()) {
  if (isKnownEvidenceExpression(expression)) return true;
  const unwrapped = unwrapAssertions(expression);
  if (unwrapped.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || visitedVariables.has(variable)) return false;
  const declarator = variableDeclarator(variable);
  if (declarator === null || declarator.init === null || !isSettledBinding(variable, declarator)) {
    return false;
  }
  visitedVariables.add(variable);
  return hasKnownEvidence(sourceCode, declarator.init, visitedVariables);
}

/**
 * @param {ESTree.TSTypeAnnotation | null | undefined} annotation
 * @param {TypeEnvironment} environment
 * @returns {WideningTarget | null}
 */
function annotationTarget(annotation, environment) {
  return annotation === null || annotation === undefined
    ? null
    : classifyWideningTarget(annotation.typeAnnotation, environment);
}

/**
 * @param {SourceCode} sourceCode
 * @param {FunctionNode | null} owner
 * @returns {string}
 */
function functionName(sourceCode, owner) {
  if (owner === null) return "anonymous function";
  if (owner.id !== null) return owner.id.name;
  const parent = owner.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (parent.type === "MethodDefinition") return propertyKeyName(parent.key, sourceCode);
  return "anonymous function";
}

/**
 * @param {ESTree.Expression} expression
 * @returns {boolean}
 */
function isEmptyObjectExpression(expression) {
  const unwrapped = unwrapAssertions(expression);
  return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}

/**
 * @param {WideningTarget} destination
 * @returns {boolean}
 */
function isDictionaryAccumulatorTarget(destination) {
  return destination.kind === "open dictionary" || destination.kind === "generic container";
}

/**
 * Whether an anonymous object target is actually wider than the value written
 * under it, which it is exactly when the value carries a property the target
 * does not name. A target listing the keys of the literal below it discards
 * nothing: it is the signature carrying the contract instead of the body, the
 * opposite of what this rule exists to find. Upstream reports that too, and it
 * is the one place this port deliberately differs. Anything the comparison
 * cannot be honest about — a spread, a computed key, a value reached through a
 * name — is left alone rather than guessed at.
 * @param {ESTree.Expression} expression
 * @param {ESTree.TSType} target
 * @param {SourceCode} sourceCode
 * @returns {boolean}
 */
function discardsProperties(expression, target, sourceCode) {
  const value = unwrapAssertions(expression);
  if (value.type !== "ObjectExpression" || target.type !== "TSTypeLiteral") return false;

  /** @type {Set<string>} */
  const named = new Set();
  for (const member of target.members) {
    if (member.type !== "TSPropertySignature" || member.computed) return false;
    named.add(propertyKeyName(member.key, sourceCode));
  }

  /** @type {string[]} */
  const written = [];
  for (const property of value.properties) {
    if (property.type !== "Property" || property.computed) return false;
    written.push(propertyKeyName(property.key, sourceCode));
  }
  return written.some((name) => !named.has(name));
}

/**
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function hasParentAssertion(node) {
  return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}

/**
 * Detect sound syntactic cases where a known value is explicitly widened and loses evidence.
 * @type {Rule}
 */
export const noKnownValueWideningRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
    },
    messages: {
      widening:
        "The known initializer supplying {{subject}} carries established type evidence, but the explicit {{target}} target type discards it. Preserve inference, use `satisfies`, or introduce/use a named owner contract; parse genuinely external data once at its boundary.",
    },
  },
  createOnce(context) {
    /** @type {TypeEnvironment | null} */
    let environment = null;

    /**
     * @param {ESTree.Expression} expression
     * @param {WideningTarget | null} destination
     * @param {string} subject
     */
    const reportFlow = (expression, destination, subject) => {
      if (destination === null) return;
      if (isDictionaryAccumulatorTarget(destination) && isEmptyObjectExpression(expression)) return;
      if (
        destination.kind === "anonymous object" &&
        !discardsProperties(expression, destination.type, context.sourceCode)
      ) {
        return;
      }
      if (!hasKnownEvidence(context.sourceCode, expression)) return;
      context.report({
        node: expression,
        messageId: "widening",
        data: { subject, target: destination.kind },
      });
    };

    /** @param {ESTree.TSTypeAnnotation | null | undefined} annotation */
    const targetFromAnnotation = (annotation) =>
      environment === null ? null : annotationTarget(annotation, environment);

    return {
      Program(node) {
        environment = createTypeEnvironment(node);
      },
      VariableDeclarator(node) {
        if (node.init === null || node.id.type !== "Identifier") return;
        reportFlow(
          node.init,
          targetFromAnnotation(node.id.typeAnnotation),
          `binding \`${node.id.name}\``,
        );
      },
      PropertyDefinition(node) {
        if (node.value === null) return;
        reportFlow(
          node.value,
          targetFromAnnotation(node.typeAnnotation),
          `property \`${propertyKeyName(node.key, context.sourceCode)}\``,
        );
      },
      AccessorProperty(node) {
        if (node.value === null) return;
        reportFlow(
          node.value,
          targetFromAnnotation(node.typeAnnotation),
          `property \`${propertyKeyName(node.key, context.sourceCode)}\``,
        );
      },
      AssignmentExpression(node) {
        if (node.operator !== "=" || node.left.type !== "Identifier") return;
        const variable = resolveVariable(context.sourceCode, node.left);
        if (variable === null) return;
        const declarator = variableDeclarator(variable);
        if (declarator === null || declarator.id.type !== "Identifier") return;
        reportFlow(
          node.right,
          targetFromAnnotation(declarator.id.typeAnnotation),
          `binding \`${declarator.id.name}\``,
        );
      },
      ReturnStatement(node) {
        if (node.argument === null) return;
        const owner = enclosingFunction(node);
        reportFlow(
          node.argument,
          targetFromAnnotation(owner?.returnType),
          `return value of \`${functionName(context.sourceCode, owner)}\``,
        );
      },
      ArrowFunctionExpression(node) {
        if (node.body.type === "BlockStatement") return;
        reportFlow(
          node.body,
          targetFromAnnotation(node.returnType),
          `return value of \`${functionName(context.sourceCode, node)}\``,
        );
      },
      TSAsExpression(node) {
        if (environment === null || hasParentAssertion(node)) return;
        reportFlow(
          node.expression,
          classifyWideningTarget(node.typeAnnotation, environment),
          "assertion",
        );
      },
      TSTypeAssertion(node) {
        if (environment === null || hasParentAssertion(node)) return;
        reportFlow(
          node.expression,
          classifyWideningTarget(node.typeAnnotation, environment),
          "assertion",
        );
      },
    };
  },
};
