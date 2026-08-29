// Ported from dmmulroy/anti-slop (MIT), level with upstream at commit 6d53855 —
// https://github.com/dmmulroy/anti-slop/tree/6d53855. This line is where that
// level is stated: this file ships inside node_modules for every repo that
// consumes the plugin, and is the only part of the port a reader of one of
// those repos can reach. Upstream vendors these
// rules into each repo; they live in this package instead because oxlint's
// jsPlugins API is alpha and not semver, so rule code and the oxlint pin have
// to move as one — which is what this package's release pair already does.
// Plain JavaScript, not TypeScript: Node refuses to strip types from any file
// under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and this
// directory is inside `node_modules` for every repo that consumes it. `tsc`
// still checks it here — `checkJs` in this repo's tsconfig.
/** @import { Plugin } from "@oxlint/plugins" */

import {
  noCallLogAssertionsRule,
  noLocalModuleMocksRule,
  noMockAssertionsRule,
} from "./rules/mocks.js";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.js";
import { noEnvAccessRule } from "./rules/no-env-access.js";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.js";
import { noRealTimersRule } from "./rules/no-real-timers.js";
import { noObjectParametersRule, noUnknownParametersRule } from "./rules/parameter-types.js";
import { noReflectApplyRule, noReflectGetRule } from "./rules/reflect.js";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.js";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.js";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.js";

/** @type {Plugin} */
const antiSlop = {
  meta: { name: "anti-slop" },
  rules: {
    "no-call-log-assertions": noCallLogAssertionsRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-env-access": noEnvAccessRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-local-module-mocks": noLocalModuleMocksRule,
    "no-mock-assertions": noMockAssertionsRule,
    "no-object-parameters": noObjectParametersRule,
    "no-real-timers": noRealTimersRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-reflect-get": noReflectGetRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
  },
};

export default antiSlop;
