import { DEPENDENCY_FIELDS, manifests, type Problem, record } from "../_lib/gate.ts";

interface DenylistEntry {
  /** Package names, matched exactly — which is what keeps `jest` from taking `jest-expo` with it. */
  readonly names?: readonly string[];
  /** Regular expressions over the package name, for a whole scope. */
  readonly patterns?: readonly string[];
  readonly reason: string;
  /** Where a deviation is legitimate, the glob whose existence records it. */
  readonly adr?: string;
}

interface Denylist {
  readonly entries: readonly DenylistEntry[];
}

function denies(entry: DenylistEntry, name: string): boolean {
  return (
    (entry.names?.includes(name) ?? false) ||
    (entry.patterns?.some((pattern) => new RegExp(pattern).test(name)) ?? false)
  );
}

function deviationRecorded(root: string, adr: string): boolean {
  const [first] = [...new Bun.Glob(adr).scanSync({ cwd: root, onlyFiles: true })];
  return first !== undefined;
}

export async function stackGate(root: string, denylistPath: string | URL): Promise<Problem[]> {
  const { entries } = (await Bun.file(denylistPath).json()) as Denylist;
  // Resolved once per rule rather than once per dependency: whether the
  // deviation is recorded is a property of the repo, and the scan hits disk.
  const live = entries.filter(
    (entry) => entry.adr === undefined || !deviationRecorded(root, entry.adr),
  );

  const found = await manifests(root);

  return [
    ...found.problems,
    ...found.read.flatMap(({ file, contents }) =>
      DEPENDENCY_FIELDS.flatMap((field) =>
        Object.keys(record(contents[field])).flatMap((name) =>
          live
            .filter((entry) => denies(entry, name))
            .map((entry) => ({
              file,
              message: `${field}.${name} is not the house pick — ${entry.reason}${
                entry.adr === undefined ? "" : `; record the deviation at ${entry.adr} to allow it`
              }`,
            })),
        ),
      ),
    ),
  ];
}
