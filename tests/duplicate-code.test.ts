import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  array,
  constant,
  constantFrom,
  integer,
  oneof,
  property,
  string,
  tuple,
  uniqueArray,
  type Arbitrary,
} from "fast-check";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import { duplicateCode, normalised } from "../.github/actions/duplicate-code/duplicate-code.ts";
import { suppressionHygiene } from "../.github/actions/suppression-hygiene/suppression-hygiene.ts";
import { check } from "../property.ts";
import { containing } from "./matchers.ts";
import { git, history, scratch, type Tree } from "./tree.ts";

// ---------------------------------------------------------------------------
// The normaliser, searched. A line of code here is tokens joined by single
// spaces, so that line is itself the model of what normalising any dressing of
// it must give back: the oracle is the generator's own plain form, never a
// second run of the scan.
// ---------------------------------------------------------------------------

const word = string({
  unit: constantFrom("a", "b", "c", "x", "y", "z", "_", "$"),
  minLength: 1,
  maxLength: 4,
}).map((name) => `v${name}`);

/** What a literal may hold beyond letters: every comment marker and every other quote. */
const MARKERS = ["a", "b", ":", ".", "//", "/*", "*/", "'", '"', "`", "#"];

function quoted(quote: string): Arbitrary<string> {
  return array(constantFrom(...MARKERS.filter((each) => each !== quote)), { maxLength: 5 }).map(
    (parts) => `${quote}${parts.join("")}${quote}`,
  );
}

/** A template on one line, its text holding comment markers and maybe a substitution. */
const template = tuple(
  array(constantFrom(...MARKERS.filter((each) => each !== "`")), { maxLength: 4 }),
  oneof(
    word.map((name) => `\${${name}}`),
    constantFrom(""),
  ),
).map(([parts, substitution]) => `\`${parts.join("")}${substitution}\``);

/**
 * A pattern literal whose body opens with a letter — a body opening with `*`
 * or `/` is a comment, not a pattern — and holds an escaped slash and a class
 * of the characters a comment scan trips on.
 */
const pattern = array(constantFrom("a", "\\/", "[/*'\"`]", ".", "x+"), { maxLength: 4 }).map(
  (parts) => `/a${parts.join("")}/g`,
);

const number = integer({ min: 0, max: 99 }).map(String);

const operand = oneof(word, number, quoted("'"), quoted('"'), template, pattern);

const operator = constantFrom("+", "-", "*", "/", "&&", "===");

/** A statement as its tokens: `name = operand (operator operand)* ;`. */
const statement = tuple(
  word,
  operand,
  array(tuple(operator, operand), { maxLength: 3 }),
  constantFrom(";", ""),
).map(([name, first, rest, end]) => [
  name,
  "=",
  first,
  ...rest.flat(),
  ...(end === "" ? [] : [end]),
]);

const blanks = string({ unit: constantFrom(" ", "\t"), minLength: 1, maxLength: 3 });
const indent = string({ unit: constantFrom(" ", "\t"), maxLength: 4 });
const trailing = string({ unit: constantFrom(" ", "\t", "\r"), maxLength: 2 });
/** What a comment may say: anything but the end of a block comment or the end of the line. */
const remark = array(constantFrom("a", "b", " ", "'", '"', "`", "//", "/*"), { maxLength: 4 })
  .map((parts) => parts.join(""))
  .filter((said) => !said.includes("*/"));
const blockComment = remark.map((said) => `/*${said}*/`);

/** Whitespace between two tokens, perhaps with a block comment inside it. */
const separator = tuple(blanks, oneof(blockComment, constantFrom("")), blanks).map(
  ([before, comment, after]) => (comment === "" ? before : `${before}${comment}${after}`),
);

/** One statement dressed: indented, its separators varied, perhaps a comment at the end. */
function dressed(tokens: readonly string[]): Arbitrary<string> {
  return tuple(
    indent,
    array(separator, { minLength: tokens.length, maxLength: tokens.length }),
    oneof(
      remark.map((said) => ` //${said}`),
      blockComment.map((said) => ` ${said}`),
    ),
    constantFrom(true, false),
    trailing,
  ).map(([lead, gaps, comment, commented, end]) => {
    const body = tokens.map((token, at) => (at === 0 ? token : `${gaps[at] ?? " "}${token}`));
    return `${lead}${body.join("")}${commented ? comment : ""}${end}`;
  });
}

/** What may sit between two statements and normalise to nothing: blank lines and whole comments. */
const between = array(
  oneof(
    indent,
    tuple(indent, remark).map(([lead, said]) => `${lead}//${said}`),
    tuple(indent, remark, remark).map(([lead, first, second]) => `${lead}/*${first}\n${second}*/`),
  ),
  { maxLength: 2 },
);

/** A statement as the plain line that models it, and a dressing of it with filler above. */
const dressedStatement = statement.chain((tokens) =>
  tuple(dressed(tokens), between).map(([line, filler]) => ({
    plain: tokens.join(" "),
    source: [...filler, line].join("\n"),
  })),
);

const program = array(dressedStatement, { minLength: 1, maxLength: 6 }).map((statements) => ({
  plain: statements.map(({ plain }) => plain),
  source: statements.map(({ source }) => source).join("\n"),
}));

function texts(source: string): string[] {
  return normalised(source).map(({ text }) => text);
}

describe("the normaliser", () => {
  // Invariant: comments, indentation, the width of whitespace and blank lines
  // never change a file's normalised lines. The wrong implementations it kills:
  // a scan that ends a string at a `//` inside it or misreads a pattern's `[/*]`
  // as a comment opening, one that keeps comments, one that compares lines
  // raw, and one that drops what follows a `/` division as if it were a
  // comment.
  test("a comment or whitespace change never changes a file's normalised lines", () => {
    check(
      property(program, ({ plain, source }) => {
        expect(texts(source)).toEqual(plain);
      }),
    );
  });

  // Invariant: order is part of what a file says. The wrong implementation it
  // kills is a normaliser answering a set or a sorted list, which would read
  // any two blocks holding the same lines as one clone.
  test("reordering a file's lines changes its normalised lines", () => {
    const distinct = uniqueArray(statement, {
      minLength: 2,
      maxLength: 6,
      selector: (tokens) => tokens.join(" "),
    });
    check(
      property(
        distinct.chain((statements) =>
          tuple(constant(statements), integer({ min: 1, max: statements.length - 1 })),
        ),
        ([statements, by]) => {
          const lines = statements.map((tokens) => tokens.join(" "));
          const rotated = [...lines.slice(by), ...lines.slice(0, by)];
          expect(texts(rotated.join("\n"))).toEqual(rotated);
          expect(texts(rotated.join("\n"))).not.toEqual(texts(lines.join("\n")));
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The clone finder, against fixture repositories whose last commit is the
// branch and whose first is the base it is measured against.
// ---------------------------------------------------------------------------

/** `count` distinct lines, each naming `name`, so two blocks share a line only when they share the name. */
function block(name: string, count: number): string {
  return Array.from(
    { length: count },
    (_, at) => `export const ${name}${at} = measure(${at}, "${name}");\n`,
  ).join("");
}

/** The same block as a copy that was re-indented and commented on its way in. */
function redressed(text: string): string {
  return text.replaceAll(/^(.+)$/gm, "    $1  /* copied */");
}

const IMPORT = 'import { measure } from "./measure.ts";\n\n';

/** The base every case starts from: one file holding the block a branch might copy. */
const BASE: Tree = {
  ".gitignore": "node_modules\n",
  "src/measure.ts": "export const measure = (at: number, name: string) => `${name}${at}`;\n",
  "src/prices.ts": IMPORT + block("price", 15),
};

async function gate(
  trees: readonly Tree[],
  configured: readonly [string, string][] = [],
): Promise<{ verdict: Verdict; root: string }> {
  const { root } = await history(...trees);
  for (const [name, value] of configured) await git(root, ["config", "--local", name, value]);
  return { verdict: await duplicateCode({ root, event: { baseRef: "", before: "" } }), root };
}

function messages({ problems }: Verdict): string[] {
  return problems.map(({ message }) => message);
}

const FIX = "into one place both call, or keep the copy with `// duplicate-code-allow -- <reason>`";

describe("the duplicate-code gate", () => {
  // The contract's failure, and the run's extension: the copy shares fifteen
  // lines and the message names both places with their ranges and that length.
  // The copy is re-indented and commented, so a finder comparing raw lines
  // passes it, and one reporting the twelve-line window rather than the run
  // names the wrong range.
  test("a block the branch copied into another file is refused, naming both places", async () => {
    const { verdict } = await gate([
      BASE,
      { ...BASE, "src/discounts.ts": `// the discount table\n${redressed(block("price", 15))}` },
    ]);

    expect(verdict.problems).toEqual([
      {
        file: "src/discounts.ts",
        line: 2,
        message: `move the 15 normalised lines src/discounts.ts:2-16 shares with src/prices.ts:3-17 ${FIX} on line 2`,
      },
    ]);
  });

  // A new file pasting its own block twice. The wrong implementations are a
  // finder that only compares across files, and one that reports the pair from
  // both ends, since the branch wrote both.
  test("a block the branch pasted twice into one file is refused once", async () => {
    const { verdict } = await gate([
      BASE,
      {
        ...BASE,
        "src/rates.ts": `${block("rate", 15)}export const separator = 1;\n${block("rate", 15)}`,
      },
    ]);

    expect(verdict.problems).toEqual([
      {
        file: "src/rates.ts",
        line: 1,
        message: `move the 15 normalised lines src/rates.ts:1-15 shares with src/rates.ts:17-31 ${FIX} on line 1`,
      },
    ]);
  });

  // Two new files holding one block are one clone, found from both ends. The
  // wrong implementation reports it twice.
  test("one block the branch wrote into two files is one refusal", async () => {
    const { verdict } = await gate([
      BASE,
      { ...BASE, "src/rates.ts": block("rate", 15), "src/tariffs.ts": block("rate", 15) },
    ]);

    expect(messages(verdict)).toEqual([
      containing("src/rates.ts:1-15 shares with src/tariffs.ts:1-15"),
    ]);
  });

  // A block whose lines repeat with a period shorter than the window matches
  // itself shifted by that period. The wrong implementation reads the two
  // overlapping ranges as two places.
  test("a block repeating itself within its own run is one block", async () => {
    const unit = '{\n  kind: "row",\n  weight: 1,\n},\n';
    const { verdict } = await gate([
      BASE,
      { ...BASE, "src/rows.ts": `export const rows = [\n${unit.repeat(5)}];\n` },
    ]);

    expect(verdict.problems).toEqual([]);
  });

  // Three adjacent pastes, each a window long: every pair of them is a clone,
  // and no reported pair overlaps itself. The wrong implementation grows a
  // same-file match along its own repetition, and names 1-24 and 13-36 as the
  // two places — ranges sharing half their lines.
  test("a block pasted three times is three pairs of places, none overlapping", async () => {
    const { verdict } = await gate([
      BASE,
      { ...BASE, "src/rates.ts": block("rate", 12).repeat(3) },
    ]);

    expect(messages(verdict)).toEqual([
      containing("src/rates.ts:1-12 shares with src/rates.ts:13-24"),
      containing("src/rates.ts:1-12 shares with src/rates.ts:25-36"),
      containing("src/rates.ts:13-24 shares with src/rates.ts:25-36"),
    ]);
  });

  // The floor, from both sides: eleven shared lines pass and twelve fail. Kills
  // a window one shorter or one longer than the contract's twelve.
  test.each([
    [11, 0],
    [12, 1],
  ])("a %i-line copy draws %i refusals", async (length, refusals) => {
    const { verdict } = await gate([
      BASE,
      { ...BASE, "src/copy.ts": `export const before = 0;\n${block("price", length)}` },
    ]);

    expect(verdict.problems).toHaveLength(refusals);
  });

  // The clone was there before the branch: both copies are on the base, and the
  // branch only adds a line to one file after it. The wrong implementation
  // grades every window of a changed file rather than the windows holding a
  // line this branch wrote.
  test("a clone the branch did not write passes", async () => {
    const before = { ...BASE, "src/old-copy.ts": block("price", 15) };
    const { verdict } = await gate([
      before,
      { ...before, "src/old-copy.ts": `${block("price", 15)}export const later = 2;\n` },
    ]);

    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toEqual(containing("no clone of 12 or more lines"));
  });

  test("a copy kept by a reasoned directive on its first line passes, and says so", async () => {
    const [first = "", ...rest] = block("price", 15).split("\n");
    const kept = `${first} // duplicate-code-allow -- the fixture mirrors the wire format\n${rest.join("\n")}`;
    const { verdict } = await gate([BASE, { ...BASE, "src/fixture.ts": kept }]);

    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toEqual(containing("1 clone kept by directive"));
    expect(verdict.log).toBe(
      "kept: src/fixture.ts:1-15 repeats src/prices.ts:3-17 (15 normalised lines) -- the fixture mirrors the wire format",
    );
  });

  // One mistake, one diagnostic: the directive without a reason keeps the clone
  // here, and the gate that holds every directive to its reason refuses it. The
  // wrong implementation is a hygiene scan that never learned the spelling,
  // which leaves a clone kept with nothing said about why.
  test("a directive with no reason keeps the clone here and is refused by suppression hygiene", async () => {
    const [first = "", ...rest] = block("price", 15).split("\n");
    const bare = `${first} // duplicate-code-allow\n${rest.join("\n")}`;
    const { verdict, root } = await gate([BASE, { ...BASE, "src/fixture.ts": bare }]);

    expect(verdict.problems).toEqual([]);
    expect(
      (await suppressionHygiene({ root, fixtures: [] })).map(
        ({ file, message }) => `${file}: ${message}`,
      ),
    ).toEqual([containing("src/fixture.ts: line 1")]);
  });

  // The directive licenses the copy it sits on. The wrong implementation reads
  // it on either side, so a block kept once can be copied again with nothing
  // in the new diff saying why.
  test("a directive on the block that was copied does not keep the new copy", async () => {
    const [first = "", ...rest] = block("price", 15).split("\n");
    const allowed = `${first} // duplicate-code-allow -- generated from the price list\n${rest.join("\n")}`;
    const before = { ...BASE, "src/prices.ts": IMPORT + allowed };
    const { verdict } = await gate([before, { ...before, "src/again.ts": block("price", 15) }]);

    expect(messages(verdict)).toEqual([containing("src/again.ts:1-15 shares with")]);
  });

  test("a branch that changed no source file says so", async () => {
    const { verdict } = await gate([BASE, { ...BASE, "README.md": "# a repo\n" }]);

    expect(verdict.problems).toEqual([]);
    expect(verdict.note).toEqual(containing("no source file changed against"));
  });

  // What is not somebody's hand-written source: a committed build and a
  // declaration file each hold a second copy of the code by design. The wrong
  // implementation reads them, and a repo committing its `dist/` — this one
  // does — fails every change it makes.
  test("a build output and a declaration file are not source", async () => {
    const { verdict } = await gate([
      BASE,
      {
        ...BASE,
        "src/rates.ts": block("rate", 15),
        "dist/rates.js": block("rate", 15),
        "src/rates.d.ts": block("rate", 15),
      },
    ]);

    expect(verdict.problems).toEqual([]);
  });

  // Nothing but the repo's tracked code is read: not a dependency, even one a
  // repo forgot to ignore, not a copy nobody committed, and not a file a
  // tracked symlink points out of the checkout at. Each holds the branch's new
  // block; the wrong implementations walk node_modules, list untracked files
  // and follow the link.
  test("a dependency, an untracked copy and a file outside the checkout are never read", async () => {
    const outside = await scratch();
    await Bun.write(join(outside, "elsewhere.ts"), block("rate", 15));
    const unignored = { ...BASE, ".gitignore": "" };
    const { root } = await history(unignored, {
      ...unignored,
      "src/rates.ts": block("rate", 15),
      "node_modules/pkg/index.js": block("rate", 15),
    });
    await symlink(join(outside, "elsewhere.ts"), join(root, "src/linked.ts"));
    await git(root, ["add", "src/linked.ts"]);
    await Bun.write(join(root, "src/scratch.ts"), block("rate", 15));

    const verdict = await duplicateCode({ root, event: { baseRef: "", before: "" } });

    expect(verdict.problems).toEqual([]);
  });

  // A reader whose git detects copies sees a file copied unchanged as a copy,
  // with no line written — so the gate's own diff must not take the reader's
  // setting. Copy detection only looks at sources the same diff modifies, which
  // is why the original is touched too, at its top, where no window of the
  // copy reaches.
  test("a reader's copy detection does not hide a copied file", async () => {
    const { verdict } = await gate(
      [
        BASE,
        {
          ...BASE,
          "src/prices.ts": `export const touched = 1;\n${BASE["src/prices.ts"]}`,
          "src/copied.ts": BASE["src/prices.ts"] ?? "",
        },
      ],
      [["diff.renames", "copies"]],
    );

    expect(messages(verdict)).toEqual([
      containing("src/copied.ts:1-17 shares with src/prices.ts:2-18"),
    ]);
  });
});
