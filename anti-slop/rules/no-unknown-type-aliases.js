/** @import { ESTree, Rule } from "@oxlint/plugins" */

/**
 * @param {ESTree.TSType} type
 * @returns {string | null}
 */
function referencedAliasName(type) {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null || type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

/**
 * Ban named aliases that merely conceal TypeScript's unknown top type.
 * @type {Rule}
 */
export const noUnknownTypeAliasesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` only renames `unknown`. Keep `unknown` explicit on an allowed `cause` field or replace it with the parsed owner type.",
    },
  },
  create(context) {
    /** @type {Map<string, ESTree.TSTypeAliasDeclaration>} */
    const aliases = new Map();

    /**
     * @param {ESTree.TSType} type
     * @param {ReadonlySet<string>} [visited]
     * @returns {boolean}
     */
    const resolvesToUnknown = (type, visited = new Set()) => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType")
        return resolvesToUnknown(type.typeAnnotation, visited);
      const name = referencedAliasName(type);
      if (name === null || visited.has(name)) return false;
      const alias = aliases.get(name);
      if (alias === undefined || alias.typeParameters !== null) return false;
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return resolvesToUnknown(alias.typeAnnotation, nextVisited);
    };

    return {
      Program(node) {
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type === "TSTypeAliasDeclaration") {
            aliases.set(declaration.id.name, declaration);
          }
        }
        for (const alias of aliases.values()) {
          if (!resolvesToUnknown(alias.typeAnnotation, new Set([alias.id.name]))) continue;
          context.report({
            node: alias.id,
            messageId: "unknownAlias",
            data: { alias: alias.id.name },
          });
        }
      },
    };
  },
};
