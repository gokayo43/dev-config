/** @import { ESTree, Rule } from "@oxlint/plugins" */

import { writtenString } from "../shared/syntax.js";

/**
 * The names the base grades as test code wherever the file sits, beside the
 * suite suffixes. `tests/anti-slop-test-support.test.ts` derives one import per
 * support-file glob in the base and requires this rule to refuse each.
 */
const SUPPORT_PARTS = new Set(["test-harness", "fixture"]);

/**
 * Whether a specifier names a test-support file: its last path segment carries
 * one of the names above as a dot-separated part after the first, so
 * `./order.fixture`, `./order.fixture.ts` and `@/tests/page.test-harness` are,
 * while `./fixture` and `./fixtures/order` are not.
 * @param {string} specifier
 * @returns {boolean}
 */
function isSupportFile(specifier) {
  const segment = specifier.slice(specifier.lastIndexOf("/") + 1);
  return segment
    .split(".")
    .slice(1)
    .some((part) => SUPPORT_PARTS.has(part));
}

/**
 * Production code cannot import a test-support file. The base grades such a
 * file as test code, which switches off the rules a suite cannot keep, so a
 * production import of one ships code that was never held to production's bar.
 * On in the base and off in the suite scope; a file that is neither, such as a
 * story or a seed script, is refused too, and a repo that wants one writes the
 * switch-off for that glob with its reason.
 * @type {Rule}
 */
export const noTestSupportImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing a test-harness or fixture file from outside the suite scope.",
    },
    messages: {
      supportImport:
        "Production code cannot import `{{specifier}}`, a test-support file the base grades as test code. Move what both need into a module of its own, and have the support file import that.",
    },
  },
  createOnce(context) {
    /**
     * @param {ESTree.Node} node
     * @param {string | null} specifier
     */
    const check = (node, specifier) => {
      if (specifier === null || !isSupportFile(specifier)) return;
      context.report({ node, messageId: "supportImport", data: { specifier } });
    };

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node.source, node.source.value);
      },
      ImportExpression(node) {
        check(node.source, writtenString(node.source));
      },
      TSImportType(node) {
        check(node.source, node.source.value);
      },
      TSExternalModuleReference(node) {
        check(node.expression, node.expression.value);
      },
    };
  },
};
