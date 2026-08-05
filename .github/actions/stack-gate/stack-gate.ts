import { basename } from "node:path";

import { type Problem, report, repoFiles } from "../_lib/gate.ts";

interface DenylistEntry {
  readonly match: readonly string[];
  readonly reason: string;
  readonly adr?: string;
}

interface Denylist {
  readonly entries: readonly DenylistEntry[];
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function matches(pattern: string, name: string): boolean {
  return pattern.startsWith("^") ? new RegExp(pattern).test(name) : pattern === name;
}

function deviationRecorded(root: string, adr: string): boolean {
  const [first] = [...new Bun.Glob(adr).scanSync({ cwd: root, onlyFiles: true })];
  return first !== undefined;
}

export async function stackGate(root: string, denylistPath: string | URL): Promise<Problem[]> {
  const { entries } = (await Bun.file(denylistPath).json()) as Denylist;
  const problems: Problem[] = [];

  for (const file of await repoFiles(root, ["package.json", "*/package.json"])) {
    if (basename(file) !== "package.json") continue;
    const manifest = (await Bun.file(`${root}/${file}`).json()) as Record<string, unknown>;

    for (const field of DEPENDENCY_FIELDS) {
      const declared = manifest[field];
      if (typeof declared !== "object" || declared === null) continue;

      for (const name of Object.keys(declared)) {
        for (const entry of entries) {
          if (!entry.match.some((pattern) => matches(pattern, name))) continue;
          if (entry.adr !== undefined && deviationRecorded(root, entry.adr)) continue;
          const escape =
            entry.adr === undefined ? "" : `; record the deviation at ${entry.adr} to allow it`;
          problems.push({
            file,
            message: `${field}.${name} is not the house pick — ${entry.reason}${escape}`,
          });
        }
      }
    }
  }

  return problems;
}

if (import.meta.main) {
  report(await stackGate(process.cwd(), new URL("./stack-denylist.json", import.meta.url)));
}
