/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import { importedBinding, resolveVariable, settledValue } from "../shared/bindings.js";
import {
  memberName,
  moduleExportName,
  patternKeyName,
  unwrapAssertions,
} from "../shared/syntax.js";

/**
 * Whether a specifier names the module a rule is about.
 * @param {ESTree.Expression | ESTree.StringLiteral | null} source
 * @param {string} module
 * @returns {boolean}
 */
function isModule(source, module) {
  return source !== null && source.type === "Literal" && source.value === module;
}

/**
 * Whether an expression denotes the module itself rather than one export of it:
 * a namespace or default import of it, a dynamic import of it, or a `const`
 * given either of those once.
 *
 * The module reached whole is every name in it at once, which is why it is a
 * question worth asking: `import * as React` followed by `React.useEffect` is
 * the same decision as importing `useEffect`, and a rule reading only the
 * specifier list is one keystroke from off.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression | null} expression
 * @param {string} module
 * @returns {boolean}
 */
function denotesModule(sourceCode, expression, module) {
  if (expression === null) return false;
  const value = unwrapAssertions(expression);

  if (value.type === "AwaitExpression") {
    const awaited = unwrapAssertions(value.argument);
    return awaited.type === "ImportExpression" && isModule(awaited.source, module);
  }
  if (value.type !== "Identifier") return false;

  const imported = importedBinding(resolveVariable(sourceCode, value));
  if (imported !== null) {
    return imported.source === module && (imported.name === "default" || imported.name === "*");
  }

  const held = settledValue(sourceCode, value);
  return held !== null && denotesModule(sourceCode, held, module);
}

/**
 * @typedef {object} SettledImport
 * @property {string} module The specifier the names belong to.
 * @property {ReadonlySet<string>} names The exports this rule refuses.
 * @property {string} description
 * @property {string} message Carries `{{name}}`, the export as this file reached it.
 */

/**
 * A rule refusing a named set of one module's exports, however a file reaches
 * them. The two below are the same decision over a different module and a
 * different list, and the ways round a rule that read only the import statement
 * are the same ways every time: rename it, take the namespace, take it later
 * with `await import`, or re-export it from a barrel and import that instead.
 *
 * A type-only import is not one of them. `typeof useEffect` in a signature
 * borrows the name without reaching the value, which is the one use of these
 * names that survives the pick they lost to.
 * @param {SettledImport} settled
 * @returns {Rule}
 */
function settledImportRule(settled) {
  const { module, names } = settled;

  return {
    meta: {
      type: "problem",
      docs: { description: settled.description },
      messages: { settledImport: settled.message },
    },
    create(context) {
      const { sourceCode } = context;

      /**
       * @param {ESTree.Node} node
       * @param {string} name
       * @returns {void}
       */
      const refuse = (node, name) => {
        context.report({ node, messageId: "settledImport", data: { name } });
      };

      /** The name as this file reached it, which is what the diagnostic quotes. */
      const from = (/** @type {string} */ name) => `${name} from ${module}`;

      return {
        /** The import as written, under whatever local name — the name that crosses is the key. */
        ImportDeclaration(node) {
          if (node.importKind === "type" || !isModule(node.source, module)) return;
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
            const name = moduleExportName(specifier.imported);
            if (names.has(name)) refuse(specifier, from(name));
          }
        },

        /**
         * The same export read off the module taken whole — a namespace or
         * default import, or a dynamic one — which forms no specifier for the
         * visitor above to see.
         */
        MemberExpression(node) {
          const name = memberName(node);
          if (name === null || !names.has(name)) return;
          if (denotesModule(sourceCode, node.object, module)) refuse(node, from(name));
        },

        /** And destructured off it, which names no property on a member expression. */
        VariableDeclarator(node) {
          if (node.id.type !== "ObjectPattern") return;
          if (!denotesModule(sourceCode, node.init, module)) return;
          for (const property of node.id.properties) {
            if (property.type !== "Property") continue;
            const name = patternKeyName(property);
            if (name !== null && names.has(name)) refuse(property, from(name));
          }
        },

        /**
         * A barrel re-exporting the name launders it past both ends: nothing
         * here forms a local binding, and the far side imports a relative
         * specifier no rule reading one file can follow. Refused at the barrel,
         * which is the end that can still tell.
         */
        ExportNamedDeclaration(node) {
          if (node.exportKind === "type" || !isModule(node.source, module)) return;
          for (const specifier of node.specifiers) {
            const name = moduleExportName(specifier.local);
            // The module itself as well as its names: `export { default as React }`
            // hands the far side every one of them, one specifier further out.
            if (names.has(name) || name === "default") refuse(specifier, from(name));
          }
        },

        /** And `export * from` carries the whole list by definition. */
        ExportAllDeclaration(node) {
          if (node.exportKind === "type" || !isModule(node.source, module)) return;
          refuse(node, from("everything"));
        },
      };
    },
  };
}

/**
 * An effect belongs in a named custom hook (STACK's Effects line). The hook's
 * name is the only place that says what the effect is for; written in the
 * component it has no name, and the question of whether Query, the router or
 * the compiler already owns the job never gets asked.
 */
export const noUnnamedEffectsRule = settledImportRule({
  module: "react",
  names: new Set(["useEffect", "useLayoutEffect", "useSyncExternalStore"]),
  description:
    "Disallow React's effect hooks outside a hooks/ directory, where the hook's name states what the effect is for.",
  message:
    "Move this effect into a named hook under `hooks/` and use `{{name}}` there — the hook's name is the only place that says what it subscribes to, and most effects are jobs Query, the router or the compiler already own.",
});

/**
 * A route's data is the loader's (STACK's Route data line). `useQuery` inside a
 * route fetches after the route has already rendered, which is the waterfall the
 * loader exists to remove — and it is the pattern's `loaderDeps` seam that keeps
 * a search param part of the key.
 */
export const noRawQueryHooksRule = settledImportRule({
  module: "@tanstack/react-query",
  names: new Set(["useQuery", "useInfiniteQuery"]),
  description:
    "Disallow the non-suspense query hooks in a route, whose data the loader ensureQueryData's ahead of the render.",
  message:
    "A route's data is the loader's: `ensureQueryData` its `queryOptions` and read them with `useSuspenseQuery` — `{{name}}` here fetches after the route has rendered. Raw `useQuery` belongs in the hook that fetches on interaction.",
});
