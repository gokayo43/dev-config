/** @import { Rule } from "@oxlint/plugins" */

import { createTypeEnvironment, resolveType } from "../shared/types.js";

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
    return {
      Program(node) {
        const environment = createTypeEnvironment(node, context.sourceCode);
        for (const alias of environment.aliases.values()) {
          // Its own name is already being resolved: an alias that refers to
          // itself defines nothing, and is not a way to spell `unknown`.
          const resolved = resolveType(
            alias.typeAnnotation,
            environment,
            new Map(),
            new Set([alias.id.name]),
          );
          if (resolved.type.type !== "TSUnknownKeyword") continue;
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
