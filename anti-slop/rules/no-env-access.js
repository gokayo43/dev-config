/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { importedBinding, isGlobalNamed, resolveVariable } from "../shared/bindings.js";
import { memberName, unwrapAssertions } from "../shared/syntax.js";

/**
 * The globals holding the environment. Bun's is a second object over the same
 * variables rather than an alias of the first, so a rule that knew only
 * `process` would be off for every file in a Bun repo that writes `Bun.env`.
 */
const HOLDERS = ["Bun", "process"];

/**
 * The modules exporting the same objects under a name the importing file
 * chooses. Importing one is not a way round this rule: `env` from
 * `node:process` IS `process.env`, and a rule keyed to the written name would
 * be turned off by an import — a one-line edit that reads as style.
 */
const HOLDER_MODULES = new Set(["bun", "node:process", "process"]);

/**
 * Whether the expression is `import.meta` — the third holder, and the one that
 * is not a binding at all, so nothing about scopes or aliases answers for it.
 * @param {ESTree.Expression} expression
 * @returns {boolean}
 */
function isImportMeta(expression) {
  const value = unwrapAssertions(expression);
  return (
    value.type === "MetaProperty" && value.meta.name === "import" && value.property.name === "meta"
  );
}

/**
 * The holder an expression is when the file imported it rather than reading the
 * global — `import process from "node:process"` and a namespace import of the
 * same module both put the object under a name the scope owns.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression} expression
 * @returns {string | null}
 */
function importedHolder(sourceCode, expression) {
  const value = unwrapAssertions(expression);
  if (value.type !== "Identifier") return null;
  const imported = importedBinding(resolveVariable(sourceCode, value));
  if (imported === null || !HOLDER_MODULES.has(imported.source)) return null;
  return imported.name === "default" || imported.name === "*" ? value.name : null;
}

/**
 * The environment a member expression reads, or nothing. Every shape this rule
 * is about — a variable by name, one in brackets, a destructuring, the whole
 * object handed to something else, a write back into it — forms this one member
 * expression first, so reporting it is reporting all of them once each.
 * @param {SourceCode} sourceCode
 * @param {ESTree.MemberExpression} node
 * @returns {string | null}
 */
function environmentIn(sourceCode, node) {
  if (memberName(node) !== "env") return null;
  const object = node.object;
  if (isImportMeta(object)) return "import.meta.env";
  const global = HOLDERS.find((holder) => isGlobalNamed(sourceCode, object, holder));
  if (global !== undefined) return `${global}.env`;
  const imported = importedHolder(sourceCode, object);
  return imported === null ? null : `${imported}.env`;
}

/**
 * Refuse the environment everywhere but the one module that owns it. A variable
 * read where it is used is read with whatever default the line felt like, so a
 * missing one reaches production as a working deploy pointed at nothing.
 * @type {Rule}
 */
export const noEnvAccessRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading or writing process.env, Bun.env and import.meta.env outside the module that validates them.",
    },
    messages: {
      envAccess:
        "Move {{name}} into this repo's `env.ts` and import the value from there — the environment is parsed and validated in one module, so a missing variable stops the process at startup instead of reaching this line as undefined.",
    },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      Program() {
        // A named import of the holder's own `env` never forms a member
        // expression, so the visitor below cannot see it. Reported at the
        // import, which is the decision, rather than at each use of it.
        for (const scope of sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            const imported = importedBinding(variable);
            if (imported === null || !HOLDER_MODULES.has(imported.source)) continue;
            if (imported.name !== "env") continue;
            const [definition] = variable.defs;
            if (definition === undefined) continue;
            context.report({
              node: definition.name,
              messageId: "envAccess",
              data: { name: `env from ${imported.source}` },
            });
          }
        }
      },

      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        const name = environmentIn(sourceCode, node);
        if (name === null) return;
        context.report({ node, messageId: "envAccess", data: { name } });
      },
    };
  },
};
