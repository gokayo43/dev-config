import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git, type Problem, repoFiles } from "../_lib/gate.ts";

/**
 * A migration lineage as the base ref carried it, and what it takes to put a
 * checkout back onto one for the length of a command.
 *
 * Its own module because it is its own subject. `replay.ts` asks what a history
 * rebuilds and `semantic-fixtures.ts` asks what running it does to rows; both
 * need the tree rolled back to the base ref first, and neither is about how
 * that is done. The rollback is deliberately narrow and deliberately
 * reversible: the lineage directories are replaced with what the base ref held,
 * a command runs against them, and the branch's own files go back — including
 * when the command throws.
 *
 * The files move rather than the checkout, because the repo's own migrator is
 * the only one there is and it reads the one path it was written to read. A
 * second checkout would mean the commands a repo wraps that migrator in — a
 * worktree's own database, a compose stack — were all answering about the other
 * tree instead of this one.
 */

/**
 * The file a drizzle migrator refuses to run without, and therefore the only
 * honest way to ask where a lineage is: a directory holding one is a lineage,
 * and one without is not.
 */
export const JOURNAL = "meta/_journal.json";

/**
 * A git read whose failure is not an answer. Most of what this gate asks git
 * has a meaningful "no" — a path that is not tracked, a branch with no parent —
 * but a read that fails because the checkout is not a repository at all, or
 * because git could not run, answers nothing: taking the empty output as "no"
 * is how a gate passes by having been handed nothing to look at.
 */
async function mustRead(
  root: string,
  args: readonly string[],
  establishing: string,
): Promise<string> {
  const ran = await git(root, args);
  if (!ran.ok) {
    throw new Error(
      `could not establish ${establishing}: \`git ${args.join(" ")}\` failed in ${root} — the upgrade gate reads the base ref out of git history, and a checkout it cannot read is refused rather than reported as having nothing to upgrade from`,
    );
  }
  return ran.stdout;
}

/** A migration lineage as the base ref had it: the directory, and every file in it. */
export interface BaseLineage {
  readonly dir: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

/** The lineage directories a listing names, as the journals in it place them. */
function lineageDirs(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path === JOURNAL || path.endsWith(`/${JOURNAL}`))
    .map((path) => path.slice(0, Math.max(0, path.length - JOURNAL.length - 1)));
}

/**
 * The shapes this gate will not replay, refused rather than worked around. A
 * lineage is replayed by replacing its directory, which is only a local act
 * when the directory holds that lineage and nothing else: a lineage at the root
 * of the project is the project, and one lineage inside another is a `rm -rf`
 * taking a lineage nobody asked it to touch.
 *
 * `swapped` is what will be replaced — the base ref's. `all` adds this tree's,
 * which is not a source of truth about what to replay (reading it as one is how
 * a relocated lineage went unnoticed) but is the only way to know what the
 * delete would reach: a lineage this branch nests inside one the base ref
 * carried is deleted by a swap that never enumerated it.
 */
function unreplayable(swapped: readonly string[], all: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  if (all.includes("")) {
    problems.push({
      file: JOURNAL,
      message: `the project root is itself a migration lineage — put the migrations in a directory of their own, since the upgrade path replays a lineage by replacing that directory`,
    });
  }

  const nested = new Map<string, { readonly inner: string; readonly outer: string }>();
  for (const dir of swapped) {
    if (dir === "") continue;
    for (const other of all) {
      if (other === "" || other === dir) continue;
      if (other.startsWith(`${dir}/`)) nested.set(`${other}|${dir}`, { inner: other, outer: dir });
      else if (dir.startsWith(`${other}/`))
        nested.set(`${dir}|${other}`, { inner: dir, outer: other });
    }
  }

  return [
    ...problems,
    ...[...nested.values()].map(({ inner, outer }) => ({
      file: `${inner}/${JOURNAL}`,
      message: `the migration lineage ${inner} is inside the lineage ${outer} — give each one a directory the other does not contain, since the upgrade path replays a lineage by replacing its directory`,
    })),
  ];
}

/**
 * Every lineage the base ref carried, read out of the base ref rather than out
 * of this branch's tree. A deployed database's journal is keyed to the lineage
 * that built it, so the branch's own directories cannot say what has to be
 * replayed: moving or deleting one would then be a lineage this gate never
 * looked for, and the run would pass by not having asked.
 *
 * A lineage the base ref did not carry is left where it is: there was none of
 * it on a database at that ref, so replaying this branch's copy from empty is
 * exactly what a deploy does with it.
 */
export async function baseLineages(
  root: string,
  rev: string,
): Promise<{ lineages: BaseLineage[]; problems: Problem[] }> {
  // The rev is one git already resolved and the repository is one it has
  // already read, so the only thing left that this can fail on is the path:
  // the project was not here at the base ref.
  const listing = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    `${rev}:./`,
  ]);
  if (!listing.ok) return { lineages: [], problems: await absentAt(root, rev) };

  const dirs = lineageDirs(listing.stdout.split("\0").filter((path) => path !== ""));
  if (dirs.length === 0) return { lineages: [], problems: [] };

  // The root pathspec is here and not in what gets replayed: a journal at the
  // project root is a shape this gate refuses, and refusing it means seeing it.
  const inTree = lineageDirs(await repoFiles(root, [JOURNAL, `*/${JOURNAL}`]));
  const problems = unreplayable(dirs, [...new Set([...dirs, ...inTree])]);
  if (problems.length > 0) return { lineages: [], problems };

  const stranded = await Promise.all(
    dirs.map(async (dir) => ({
      dir,
      there: await Bun.file(join(root, dir, JOURNAL)).exists(),
    })),
  );
  const moved = stranded
    .filter(({ there }) => !there)
    .map(({ dir }) => ({
      message: `${rev.slice(0, 7)} carries the migration lineage ${dir} and this tree does not — a deployed database's journal names the migrations that built it, so moving or deleting a lineage strands every database that has one; leave it where it is and add to it`,
    }));
  if (moved.length > 0) return { lineages: [], problems: moved };

  const lineages = await Promise.all(dirs.map((dir) => filesAt(root, rev, dir)));
  return { lineages, problems: [] };
}

/**
 * What it means that this project's directory was not at the base ref, which is
 * two different things and only one of them is safe.
 *
 * A project this branch adds has no base lineage, and no database anywhere was
 * built from one: the honest pass. A project that was somewhere else at the
 * base ref has exactly the lineage the gate exists to protect, one path over —
 * and every database built from it is stranded the moment the directory moves,
 * for the same reason a moved lineage strands one.
 *
 * git already knows which it is, so it is asked rather than guessed at: a
 * rename whose destination is inside this project carries a lineage into it.
 */
async function absentAt(root: string, rev: string): Promise<Problem[]> {
  const prefix = (
    await mustRead(
      root,
      ["rev-parse", "--show-prefix"],
      "where this project sits in the repository",
    )
  ).trim();
  const renames = await mustRead(
    root,
    ["diff", "--find-renames", "--name-status", "--diff-filter=R", rev, "HEAD"],
    `what moved between ${rev.slice(0, 7)} and this branch`,
  );

  return renames
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([, from, to]) =>
        from !== undefined &&
        to !== undefined &&
        to.startsWith(prefix) &&
        (from === JOURNAL || from.endsWith(`/${JOURNAL}`)),
    )
    .map(([, from, to]) => ({
      message: `${to} was ${from} at ${rev.slice(0, 7)}, so this project's migration lineage moved with it — a deployed database's journal names the migrations that built it, and moving them strands every database that has one; leave the lineage where it was and add to it`,
    }));
}

async function filesAt(root: string, rev: string, dir: string): Promise<BaseLineage> {
  const listed = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    `${rev}:./${dir}`,
  ]);
  if (!listed.ok) throw new Error(`could not read ${dir} at ${rev}`);

  const names = listed.stdout.split("\0").filter((name) => name !== "");
  const inside = join(root, dir);
  const files = await inBatches(names, async (path) => {
    // A tree entry may be named anything a `git mktree` was willing to write,
    // `..` included — git only warns about one — and these paths are turned
    // into files. A write that lands outside the directory being replaced is
    // one the restore below would not put back, so it is refused instead.
    const target = join(inside, path);
    if (!target.startsWith(`${inside}/`)) {
      throw new Error(
        `${rev.slice(0, 7)} holds a migration file at ${dir}/${path}, which is outside ${dir} — the upgrade path replays a lineage by replacing its directory, and a file that escapes it is not part of one`,
      );
    }
    const blob = await git(root, ["show", `${rev}:./${dir}/${path}`]);
    if (!blob.ok) throw new Error(`could not read ${dir}/${path} at ${rev}`);
    return { path, text: blob.stdout };
  });
  return { dir, files };
}

/** How many git reads run at once: a long lineage would otherwise be a process per file. */
const AT_ONCE = 16;

async function inBatches<T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = [];
  for (let start = 0; start < items.length; start += AT_ONCE) {
    done.push(...(await Promise.all(items.slice(start, start + AT_ONCE).map(each))));
  }
  return done;
}

/**
 * Runs `body` with every lineage rolled back to what the base ref had, and the
 * tree exactly as it found it afterwards — including when `body` throws. The
 * migrator is the repo's own and reads the one path it was written to read, so
 * the files are what moves; the alternative is a second checkout, and the
 * commands a repo wraps its migrator in (a worktree's own database, a compose
 * stack) would all be answering about that other tree instead of this one.
 *
 * Every directory here is a lineage directory that contains no other — see
 * `unreplayable`, which is what makes replacing one a local act.
 */
export async function onTheBaseLineage<T>(
  root: string,
  lineages: readonly BaseLineage[],
  body: () => Promise<T>,
): Promise<T> {
  const saved = await mkdtemp(join(tmpdir(), "head-lineage-"));
  let keep = false;
  try {
    // Every lineage is saved before any is touched, so that the restore below
    // has what it needs for all of them by the time anything needs restoring.
    // Interleaved, a save that failed could follow a delete that succeeded, and
    // the restore would then throw over a lineage it never held — losing the
    // directory and the error that started it in the same breath.
    await Promise.all(
      lineages.map(({ dir }) => cp(join(root, dir), join(saved, dir), { recursive: true })),
    );

    let outcome: { readonly value: T } | { readonly failed: unknown };
    try {
      await Promise.all(
        lineages.map(async ({ dir, files }) => {
          await rm(join(root, dir), { recursive: true, force: true });
          for (const file of files) await Bun.write(join(root, dir, file.path), file.text);
        }),
      );
      outcome = { value: await body() };
    } catch (failed) {
      outcome = { failed };
    }

    // Settled rather than raced, and reported rather than thrown from a
    // `finally`: a restore that fails while the replay has already failed would
    // otherwise replace the diagnostic the author needs with an ENOENT, and the
    // directory it could not put back would be deleted with the copy below.
    const unrestored = (
      await Promise.allSettled(
        lineages.map(async ({ dir }) => {
          await rm(join(root, dir), { recursive: true, force: true });
          await cp(join(saved, dir), join(root, dir), { recursive: true });
        }),
      )
    ).flatMap((settled) => (settled.status === "rejected" ? [String(settled.reason)] : []));

    if (unrestored.length > 0) {
      keep = true;
      const first =
        "failed" in outcome ? ` The replay had already failed: ${String(outcome.failed)}` : "";
      throw new Error(
        `this branch's own migration files could not be put back: ${unrestored.join("; ")} — the only copy is ${saved}, which has been left in place; restore it before doing anything else with this checkout.${first}`,
      );
    }
    if ("failed" in outcome) throw outcome.failed;
    return outcome.value;
  } finally {
    if (!keep) await rm(saved, { recursive: true, force: true });
  }
}
