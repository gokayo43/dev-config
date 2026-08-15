/* oxlint-disable anti-slop/no-shape-in-symbol-names -- the one file that has to name the word it bans; spelling its own symbols around the rule is what made them pretend the term was configurable */
/** @import { ESTree, Rule } from "@oxlint/plugins" */

/**
 * @param {string} name
 * @returns {boolean}
 */
function mentionsShape(name) {
  return name.toLowerCase().includes("shape");
}

/**
 * Whether the file declares this name rather than reading one someone else
 * chose. A key is a declaration in an object literal and a reference in a
 * destructuring pattern, where it names the property being read out of a value
 * the file does not own — the binding beside it is the name it did choose, and
 * the scope manager already holds that one.
 * @param {ESTree.Node & { name: string }} node
 * @param {ReadonlySet<number>} bindings
 * @returns {boolean}
 */
function declaresName(node, bindings) {
  if (bindings.has(node.start)) return true;
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === "Property") {
    return parent.key === node && !parent.computed && parent.parent.type === "ObjectExpression";
  }
  // The members a file writes out: names it chose, which bind nothing.
  if (
    parent.type === "AccessorProperty" ||
    parent.type === "MethodDefinition" ||
    parent.type === "PropertyDefinition" ||
    parent.type === "TSMethodSignature" ||
    parent.type === "TSPropertySignature"
  ) {
    return parent.key === node && !parent.computed;
  }
  return false;
}

/**
 * Ban the case-insensitive substring "shape" in the names a file declares.
 *
 * Upstream reports every identifier, which is the second place this port
 * deliberately differs: `schema.shape` is zod's documented API and
 * `svg.shapeRendering` is an SVG attribute, so at `error` fleet-wide the rule
 * refuses names no consuming repo can change and offers a per-site disable as
 * the only remedy. A name is worth refusing where it is chosen.
 * @type {Rule}
 */
export const noShapeInSymbolNamesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in the JavaScript, TypeScript and private names a file declares.',
    },
    messages: {
      shapeInName:
        'Do not use the case-insensitive substring "shape" in symbol names (found "{{name}}"). Name the thing by what it is.',
    },
  },
  createOnce(context) {
    /** @type {Set<number>} */
    let bindings = new Set();
    /** @type {Set<number>} */
    let reported = new Set();

    /** @param {ESTree.Node & { name: string }} node */
    const reportIfNamedForShape = (node) => {
      // By position, because an import with no `as` holds the imported name and
      // the local binding as two nodes over the same characters, and one name in
      // one place is one diagnostic.
      if (reported.has(node.start) || !mentionsShape(node.name)) return;
      if (!declaresName(node, bindings)) return;
      reported.add(node.start);
      context.report({ node, messageId: "shapeInName", data: { name: node.name } });
    };

    return {
      Program() {
        bindings = new Set(
          context.sourceCode.scopeManager.scopes.flatMap((scope) =>
            scope.variables.flatMap((variable) =>
              variable.identifiers.map((identifier) => identifier.start),
            ),
          ),
        );
        reported = new Set();
      },
      Identifier: reportIfNamedForShape,
      PrivateIdentifier: reportIfNamedForShape,
    };
  },
};
