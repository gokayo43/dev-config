import type { Tree } from "./tree.ts";

/**
 * The fixture repos every suite that drives a migrator builds: a drizzle
 * lineage on disk, and the package script that names it. Here rather than in
 * one of those suites because two of them need the same tree — the replay gate
 * asks what a history rebuilds, the backfill check needs a schema before it can
 * put rows in one.
 */

/** One migration as a lineage holds it: a file, and the journal row that orders it. */
export interface Migration {
  readonly tag: string;
  /** The journal's own clock. An applied migration is recognised by this and nothing else. */
  readonly when: number;
  readonly sql: string;
}

/**
 * A drizzle lineage under `dir`, in the shape `drizzle-kit generate` writes: the
 * journal beside the files it names. Captured from a real generate run — the
 * migrator reads `entries` and refuses a folder without the file.
 */
export function lineage(dir: string, ...migrations: readonly Migration[]): Tree {
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: migrations.map(({ when, tag }, idx) => ({
      idx,
      version: "7",
      when,
      tag,
      breakpoints: true,
    })),
  };
  return {
    [`${dir}/meta/_journal.json`]: JSON.stringify(journal, undefined, 2),
    ...Object.fromEntries(migrations.map(({ tag, sql }) => [`${dir}/${tag}.sql`, sql])),
  };
}

/** The repo's declaration of how it migrates, and of where its lineages are. */
export function migratesFrom(migrator: string, ...dirs: readonly string[]): Tree {
  return scripted(`bun run ${migrator} ${dirs.map((dir) => `./${dir}`).join(" ")}`);
}

export function scripted(script: string): Tree {
  return {
    "package.json": `${JSON.stringify(
      { name: "fixture", private: true, type: "module", scripts: { "db:migrate": script } },
      undefined,
      2,
    )}\n`,
  };
}
