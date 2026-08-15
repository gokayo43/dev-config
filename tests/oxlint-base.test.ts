import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { jsonObjects, record } from "../.github/actions/_lib/gate.ts";

const REPO = dirname(import.meta.dir);

/**
 * The base itself, read through the gates' own JSONC decoder — it carries the
 * reason for every entry in it as a comment, which is the thing the README
 * asks every repo to write and `JSON.parse` refuses.
 */
const base = record(
  (await jsonObjects(REPO, ["oxlint.base.json"], "JSON with comments")).read[0]?.value,
);

/**
 * The rules whose configuration is a list of entries rather than one options
 * object: the settled-decision choke pattern the README describes. Anything
 * here that the base states at the top level has to hold everywhere, and an
 * override REPLACES a rule's whole configuration rather than adding to it
 * (oxc#12179) — so an override that redefines one and drops an entry silently
 * exempts every file it matches, in every repo that extends this file.
 */
const ENTRY_LIST_RULES = [
  "no-restricted-globals",
  "no-restricted-imports",
  "no-restricted-properties",
];

/** A rule's configured entries — everything after the severity, which is the list itself. */
function entriesOf(configured: unknown): string[] {
  return Array.isArray(configured) ? configured.slice(1).map((entry) => JSON.stringify(entry)) : [];
}

describe("the base's list-shaped rules", () => {
  const overrides = Array.isArray(base["overrides"]) ? base["overrides"] : [];
  const rules = record(base["rules"]);

  const redefinitions = ENTRY_LIST_RULES.flatMap((rule) =>
    overrides.flatMap((override) => {
      const configured = record(record(override)["rules"])[rule];
      return configured === undefined
        ? []
        : [{ rule, files: JSON.stringify(record(override)["files"]), configured }];
    }),
  );

  // Otherwise every case below passes on an empty list, which is the state this
  // whole file exists to notice: the base having stopped carrying the pattern.
  test("the base states a list-shaped rule and an override redefines one", () => {
    expect(ENTRY_LIST_RULES.filter((rule) => entriesOf(rules[rule]).length > 0)).not.toEqual([]);
    expect(redefinitions).not.toEqual([]);
  });

  test.each(redefinitions)(
    "$rule in the override for $files still carries every entry the base states",
    ({ rule, configured }) => {
      const carried = entriesOf(configured);
      expect(entriesOf(rules[rule]).filter((entry) => !carried.includes(entry))).toEqual([]);
    },
  );
});
