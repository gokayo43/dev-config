/**
 * check.yml as its suites read it: the parsed workflow, the two jobs and the
 * inputs it declares, and a way to run one of its shell steps in a fixture
 * repository.
 */
import { type ConfigObject, record } from "../.github/actions/_lib/gate.ts";
import { materialise, type Tree } from "./tree.ts";

const CHECK = new URL("../.github/workflows/check.yml", import.meta.url).pathname;

const DOCUMENT = record(Bun.YAML.parse(await Bun.file(CHECK).text()));

export const STATIC = record(record(DOCUMENT["jobs"])["static"]);

export const DATABASE_JOB = record(record(DOCUMENT["jobs"])["database"]);

/** What a caller may pass, as this workflow declares it. */
export const INPUTS = record(record(record(DOCUMENT["on"])["workflow_call"])["inputs"]);

export function scriptOf(step: unknown): string {
  const run = record(step)["run"];
  return typeof run === "string" ? run : "";
}

/** One string field of a mapping, or the empty string — a key absent reads as unset. */
export function textAt(held: ConfigObject, key: string): string {
  const value = held[key];
  return typeof value === "string" ? value : "";
}

export interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly output: string;
}

export async function ran(
  script: string,
  tree: Tree,
  environment: Record<string, string>,
): Promise<Ran> {
  const root = await materialise(tree);
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, stdout: out, output: out + err };
}
