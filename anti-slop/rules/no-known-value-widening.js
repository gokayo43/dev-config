/** @import { ESTree, Rule, Scope, SourceCode, Variable } from "@oxlint/plugins" */
/** @import { TypeEnvironment, WideningTarget } from "../shared/dictionary-types.js" */

import {
  classifyWideningTarget,
  createTypeEnvironment,
  isKnownEvidenceExpression,
} from "../shared/dictionary-types.js";

/** @typedef {ESTree.ArrowFunctionExpression | ESTree.Function} FunctionExpression */

/**
 * @param {ESTree.Expression} expression
 * @returns {ESTree.Expression}
 */
function unwrapExpression(expression) {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {Variable | null}
 */
function resolveVariable(sourceCode, identifier) {
  /** @type {Scope | null} */
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * @param {Variable} variable
 * @returns {ESTree.VariableDeclarator | null}
 */
function variableDeclarator(variable) {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

/**
 * @param {Variable} variable
 * @param {ESTree.VariableDeclarator} declarator
 * @returns {boolean}
 */
function isStableConstVariable(variable, declarator) {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    variable.references.every((reference) => reference.init || !reference.isWrite())
  );
}

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @param {Set<Variable>} [visitedVariables]
 * @returns {boolean}
 */
function hasKnownEvidence(sourceCode, expression, visitedVariables = new Set()) {
  if (isKnownEvidenceExpression(expression)) return true;
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || visitedVariables.has(variable)) return false;
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.init === null ||
    !isStableConstVariable(variable, declarator)
  ) {
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
 * @param {ESTree.Node} node
 * @returns {FunctionExpression | null}
 */
function enclosingFunction(node) {
  /** @type {ESTree.Node | null} */
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.PropertyKey} key
 * @returns {string}
 */
function sourceKeyName(sourceCode, key) {
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return sourceCode.getText(key);
}

/**
 * @param {SourceCode} sourceCode
 * @param {FunctionExpression | null} owner
 * @returns {string}
 */
function functionName(sourceCode, owner) {
  if (owner === null) return "anonymous function";
  if (owner.id !== null) return owner.id.name;
  const parent = owner.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
    return parent.id.name;
  if (parent.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
  return "anonymous function";
}

/**
 * @param {ESTree.Expression} expression
 * @returns {boolean}
 */
function isEmptyObjectExpression(expression) {
  const unwrapped = unwrapExpression(expression);
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
          `property \`${sourceKeyName(context.sourceCode, node.key)}\``,
        );
      },
      AccessorProperty(node) {
        if (node.value === null) return;
        reportFlow(
          node.value,
          targetFromAnnotation(node.typeAnnotation),
          `property \`${sourceKeyName(context.sourceCode, node.key)}\``,
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
