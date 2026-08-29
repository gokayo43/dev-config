/** @import { ESTree, Rule, SourceCode } from "@oxlint/plugins" */

import {
  importedBinding,
  isGlobalNamed,
  resolveVariable,
  settledValue,
} from "../shared/bindings.js";
import {
  isWriteTarget,
  memberName,
  moduleExportName,
  outermostMember,
  patternKeyName,
  unwrapAssertions,
} from "../shared/syntax.js";

/**
 * The globals holding the environment. Bun's is a second object over the same
 * variables rather than an alias of the first, so a rule that knew only
 * `process` would be off for every file in a Bun repo that writes `Bun.env`.
 */
const HOLDERS = ["Bun", "process"];

/**
 * The modules that export the same holders under a name the importing file
 * chooses. Importing one is not a way round this rule: `env` from
 * `node:process` IS `process.env`, and a rule keyed to the written name would
 * be turned off by an import — a one-line edit that reads as style.
 */
const HOLDER_MODULES = new Set(["bun", "node:process", "process"]);

/** The property of a holder this rule is about. */
const ENVIRONMENT = "env";

/**
 * Whether a module specifier is one of the holders'.
 * @param {ESTree.Expression | null} source
 * @returns {boolean}
 */
function isHolderModule(source) {
  return (
    source !== null &&
    source.type === "Literal" &&
    typeof source.value === "string" &&
    HOLDER_MODULES.has(source.value)
  );
}

/**
 * The holder an expression denotes, or nothing — the one question this rule
 * asks, with every way of reaching a holder answered in this one place. A
 * second derivation of it is how the destructuring, the import and the member
 * read end up disagreeing about what `process` is.
 *
 * Five ways: the global under any of its names, `import.meta`, an import of a
 * holder module, a dynamic import of one, and a `const` given any of those once.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Expression | null} expression
 * @returns {string | null}
 */
function holderIn(sourceCode, expression) {
  if (expression === null) return null;
  const value = unwrapAssertions(expression);

  if (
    value.type === "MetaProperty" &&
    value.meta.name === "import" &&
    value.property.name === "meta"
  ) {
    return "import.meta";
  }
  if (value.type === "AwaitExpression") {
    const awaited = unwrapAssertions(value.argument);
    if (awaited.type !== "ImportExpression" || !isHolderModule(awaited.source)) return null;
    return `import(${sourceCode.getText(awaited.source)})`;
  }

  const global = HOLDERS.find((holder) => isGlobalNamed(sourceCode, value, holder));
  if (global !== undefined) return global;
  if (value.type !== "Identifier") return null;

  const imported = importedBinding(resolveVariable(sourceCode, value));
  if (imported !== null) {
    return HOLDER_MODULES.has(imported.source) &&
      (imported.name === "default" || imported.name === "*")
      ? value.name
      : null;
  }

  // `isGlobalNamed` follows a `const` for a global; a name given an import or a
  // dynamic import is the same evidence about the same object, and is followed
  // here rather than left as the one alias this rule does not read.
  const held = settledValue(sourceCode, value);
  return held === null ? null : holderIn(sourceCode, held);
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
      envRead:
        "Move {{name}} into this repo's `env.ts` and import the value from there — the environment is parsed and validated in one module, so a missing variable stops the process at startup instead of reaching this line as undefined.",
      envWrite:
        "Set {{name}} where the process is started, not from inside it — a variable written here is one the module that validated the environment has already answered for, and the two now disagree.",
      envImport:
        "Import the parsed value from this repo's `env.ts` instead of `{{name}}` — the environment is read in one module, and an import of it here is a second one.",
    },
  },
  create(context) {
    const { sourceCode } = context;

    /**
     * @param {ESTree.Node} node
     * @param {string} name
     * @returns {void}
     */
    const reportImport = (node, name) => {
      context.report({ node, messageId: "envImport", data: { name } });
    };

    return {
      /** `process.env`, and every property read, write or spread that starts with it. */
      MemberExpression(node) {
        if (memberName(node) !== ENVIRONMENT) return;
        const holder = holderIn(sourceCode, node.object);
        if (holder === null) return;
        const written = isWriteTarget(outermostMember(node));
        context.report({
          node,
          messageId: written ? "envWrite" : "envRead",
          data: { name: `${holder}.${ENVIRONMENT}` },
        });
      },

      /**
       * `const { env } = process`, which reads the same object with no member
       * expression anywhere in it — the shape a rule watching only for `.env`
       * is silent on, and the one an author reaches for once it is not.
       */
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern") return;
        const holder = holderIn(sourceCode, node.init);
        if (holder === null) return;
        for (const property of node.id.properties) {
          if (property.type !== "Property" || patternKeyName(property) !== ENVIRONMENT) continue;
          context.report({
            node: property,
            messageId: "envRead",
            data: { name: `${holder}.${ENVIRONMENT}` },
          });
        }
      },

      /**
       * A named import of the holder's own `env`, which forms no member
       * expression at all. Reported at the import: it is the decision, and the
       * edit that would otherwise turn this rule off by spelling its subject
       * differently.
       */
      ImportDeclaration(node) {
        if (!isHolderModule(node.source)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          if (moduleExportName(specifier.imported) !== ENVIRONMENT) continue;
          reportImport(specifier, `${ENVIRONMENT} from ${node.source.value}`);
        }
      },

      /**
       * A re-export creates no local binding, so nothing above sees it and the
       * far side imports a relative specifier one file cannot read across — the
       * environment laundered through a module of the repo's own, silent at both
       * ends. Refused here, which is the end that can still tell.
       */
      ExportNamedDeclaration(node) {
        if (node.source === null || !isHolderModule(node.source)) return;
        for (const specifier of node.specifiers) {
          // The holder itself as well as its `env`: `export { default as proc }`
          // hands the far side the whole module, and reading `env` off it there
          // is the same laundering one specifier further out.
          const local = moduleExportName(specifier.local);
          if (local !== ENVIRONMENT && local !== "default") continue;
          reportImport(specifier, `${local} from ${node.source.value}`);
        }
      },

      /** `export * from "node:process"` carries `env` by definition. */
      ExportAllDeclaration(node) {
        if (!isHolderModule(node.source)) return;
        reportImport(node, `everything from ${node.source.value}`);
      },
    };
  },
};
