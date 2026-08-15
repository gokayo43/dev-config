/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

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
 * @param {Parameter} parameter
 * @returns {ESTree.TSTypeAnnotation | null | undefined}
 */
function parameterAnnotation(parameter) {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

/**
 * @param {Parameter} parameter
 * @param {SourceCode} sourceCode
 * @returns {string}
 */
function parameterName(parameter, sourceCode) {
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

/**
 * Ban the broad object type on function inputs, including local aliases to object.
 * @type {Rule}
 */
export const noObjectParametersRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
    },
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` accepts the broad `object` type. Use the expected owner type or decode the external input at its boundary.",
    },
  },
  create(context) {
    /** @type {Map<string, ESTree.TSType>} */
    const aliases = new Map();

    /**
     * @param {ESTree.TSType} type
     * @param {ReadonlySet<string>} [visited]
     * @returns {boolean}
     */
    const resolvesToObject = (type, visited = new Set()) => {
      if (type.type === "TSObjectKeyword") return true;
      if (type.type === "TSParenthesizedType")
        return resolvesToObject(type.typeAnnotation, visited);
      if (type.type === "TSUnionType") {
        return type.types.some((member) => resolvesToObject(member, visited));
      }
      if (
        type.type !== "TSTypeReference" ||
        type.typeName.type !== "Identifier" ||
        (type.typeArguments !== null && type.typeArguments.params.length > 0) ||
        visited.has(type.typeName.name)
      ) {
        return false;
      }
      const alias = aliases.get(type.typeName.name);
      if (alias === undefined) return false;
      const nextVisited = new Set(visited);
      nextVisited.add(type.typeName.name);
      return resolvesToObject(alias, nextVisited);
    };

    /** @param {ParameterOwner} node */
    const checkParameters = (node) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!resolvesToObject(annotation.typeAnnotation)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "objectParameter",
          data: { parameter: parameterName(parameter, context.sourceCode) },
        });
      }
    };

    return {
      Program(node) {
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (
            declaration?.type === "TSTypeAliasDeclaration" &&
            declaration.typeParameters === null
          ) {
            aliases.set(declaration.id.name, declaration.typeAnnotation);
          }
        }
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
