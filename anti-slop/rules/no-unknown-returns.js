/** @import { ESTree, Rule } from "@oxlint/plugins" */
/** @import { Substitutions, TypeEnvironment } from "../shared/types.js" */

import { typeReferenceName } from "../shared/syntax.js";
import { createTypeParameterScopes } from "../shared/type-parameters.js";
import { createTypeEnvironment, resolveType } from "../shared/types.js";

/**
 * @typedef {ESTree.ArrowFunctionExpression
 *   | ESTree.Function
 *   | ESTree.TSCallSignatureDeclaration
 *   | ESTree.TSConstructSignatureDeclaration
 *   | ESTree.TSConstructorType
 *   | ESTree.TSFunctionType
 *   | ESTree.TSMethodSignature} ReturnTypeOwner
 */

/**
 * Ban function contracts that hand `unknown` back to the caller.
 *
 * The sibling of `no-unknown-parameters` on the other side of the signature,
 * and the same decision only as far as the keyword: a return has no `cause`
 * convention to exempt, and it has to be read through `Promise`, because
 * `Promise<unknown>` is the same contract one await later.
 * @type {Rule}
 */
export const noUnknownReturnsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    /** @type {TypeEnvironment | null} */
    let environment = null;
    const scopes = createTypeParameterScopes();

    /**
     * The awaited answer counts, which is the whole reason this reads through
     * `Promise` rather than stopping at the reference: a caller that awaits
     * `Promise<unknown>` is holding `unknown`.
     * @param {string | null} name
     * @returns {boolean}
     */
    const isGlobalPromise = (name) =>
      environment !== null &&
      (name === "Promise" || name === "PromiseLike") &&
      !environment.shadowedBuiltIns.has(name);

    /**
     * @param {ESTree.TSType} type
     * @param {Substitutions} substitutions
     * @param {ReadonlySet<string>} resolving
     * @returns {boolean}
     */
    const answersUnknown = (type, substitutions, resolving) => {
      if (environment === null) return false;
      const resolved = resolveType(type, environment, substitutions, resolving);
      const node = resolved.type;
      if (node.type === "TSUnknownKeyword") return true;

      // A union is `unknown` the moment one member is: `string | unknown`
      // collapses to `unknown`, and the annotation is the contract either way.
      if (node.type === "TSUnionType") {
        return node.types.some((member) =>
          answersUnknown(member, resolved.substitutions, resolved.resolving),
        );
      }
      if (node.type !== "TSTypeReference" || !isGlobalPromise(typeReferenceName(node))) {
        return false;
      }
      const value = node.typeArguments?.params[0];
      return (
        value !== undefined && answersUnknown(value, resolved.substitutions, resolved.resolving)
      );
    };

    /** @param {ReturnTypeOwner} node */
    const checkReturnType = (node) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!answersUnknown(annotation.typeAnnotation, new Map(), scopes.at(node))) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        environment = createTypeEnvironment(node);
        scopes.reset();
      },
      TSInferType: scopes.record,
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
};
