// Ported from dmmulroy/anti-slop (MIT) at commit abaeb63 —
// https://github.com/dmmulroy/anti-slop/tree/abaeb63. Upstream vendors these
// rules into each repo; they live in this package instead because oxlint's
// jsPlugins API is alpha and not semver, so rule code and the oxlint pin have
// to move as one — which is what this package's release pair already does.
// Plain JavaScript, not TypeScript: Node refuses to strip types from any file
// under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and this
// directory is inside `node_modules` for every repo that consumes it. `tsc`
// still checks it here — `checkJs` in this repo's tsconfig.
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- the rule named for the word it bans is imported here under its own name, rather than under one spelled around itself */
/** @import { Plugin } from "@oxlint/plugins" */

import { noLocalModuleMocksRule, noMockAssertionsRule } from "./rules/mocks.js";
import { noCallCountAssertionsRule } from "./rules/no-call-count-assertions.js";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.js";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.js";
import { noRealTimersRule } from "./rules/no-real-timers.js";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.js";
import { noObjectParametersRule, noUnknownParametersRule } from "./rules/parameter-types.js";
import { noShapeInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.js";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.js";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.js";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.js";

/** @type {Plugin} */
const antiSlop = {
  meta: { name: "anti-slop" },
  rules: {
    "no-call-count-assertions": noCallCountAssertionsRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-local-module-mocks": noLocalModuleMocksRule,
    "no-mock-assertions": noMockAssertionsRule,
    "no-object-parameters": noObjectParametersRule,
    "no-real-timers": noRealTimersRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-shape-in-symbol-names": noShapeInSymbolNamesRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-widen-then-assert": noWidenThenAssertRule,
  },
};

export default antiSlop;
