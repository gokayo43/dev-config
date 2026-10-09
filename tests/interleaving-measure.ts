import { type Arbitrary, check, property, sample } from "fast-check";

import { type Interleaving, interleavings } from "../interleaving.ts";
import { races } from "./interleaving-fixtures.ts";

// Re-takes the measurement table on docs/exports/interleaving.md:
// `bun tests/interleaving-measure.ts` prints its rows.

const SHARE_RUNS = 20_000;
const SEEDS = 20;
const CAP = 3_000;

const strategies: [string, (ops: number) => Arbitrary<Interleaving>][] = [
  ["walk", (ops) => interleavings(ops).filter(({ strategy }) => strategy === "walk")],
  ["priority", (ops) => interleavings(ops).filter(({ strategy }) => strategy === "priority")],
  ["mixed", interleavings],
];

const percent = (share: number) => `${(share * 100).toPrecision(2)}%`;

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = sorted.length / 2;
  return Number.isInteger(middle)
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[Math.floor(middle)] ?? 0);
};

const row = (cells: readonly string[]) => process.stdout.write(`| ${cells.join(" | ")} |\n`);

row([
  "Fixture",
  "`ops`",
  "Strategy",
  "Share failing",
  "Median runs to find",
  "Slowest of 20 seeds",
]);
row(["---", "---", "---", "---", "---", "---"]);
for (const race of races) {
  const ops = race.ops(false);
  for (const [index, [strategy, arbitrary]] of strategies.entries()) {
    const generated = arbitrary(ops);
    const failing = sample(generated, { seed: 1, numRuns: SHARE_RUNS }).filter(
      (interleaving) => !race.holds(false, interleaving),
    ).length;
    const found = Array.from({ length: SEEDS }, (_, seed) => {
      const details = check(
        property(generated, (interleaving) => race.holds(false, interleaving)),
        { seed: seed + 1, numRuns: CAP, endOnFailure: true },
      );
      return details.failed ? details.numRuns : Number.POSITIVE_INFINITY;
    });
    const cells = index === 0 ? [race.name, String(ops)] : ["", ""];
    row([
      ...cells,
      strategy,
      percent(failing / SHARE_RUNS),
      String(median(found)),
      found.includes(Number.POSITIVE_INFINITY)
        ? `not found within ${CAP}`
        : String(Math.max(...found)),
    ]);
  }
}
