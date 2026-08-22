/**
 * What a repo's `lifecycle` says, and everything the word "live" derives.
 *
 * The rest of the contract grades a repo the same way whether or not anyone is
 * on the other end of it: a package manager is pinned or it is not. This half
 * grades what having users costs — a dump nobody took, a restore nobody
 * rehearsed, a crash nobody was told about, a migration nobody proved upgrades
 * — and every rule in it is reached through one field. Its own file, because
 * one word deciding whether a whole rule set applies is a different subject
 * from the facts that always apply, and the diff of a new live rule should read
 * as a rule rather than as a change to the contract.
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

import {
  baseRevision,
  type ConfigObject,
  type Event,
  git,
  isObject,
  type Manifest,
  type Missing,
  oneOf,
  type Problem,
  record,
} from "../_lib/gate.ts";
import { CI_WORKFLOW } from "./ci-workflow.ts";

/**
 * Whether the repo is deployed and carrying people, said by the repo about
 * itself rather than inferred from anything. Nothing derives it — a repo with a
 * hostname, a compose file and a backup script is indistinguishable from one
 * three days away from its first deploy — so it is declared, and moving it to
 * `live` is the owner's own commit. Everything below it reconfigures off that
 * one word.
 */
const LIFECYCLES = ["dev", "live"] as const;

type Lifecycle = (typeof LIFECYCLES)[number];

/**
 * The field as written and as read, derived once. Two readings of one manifest
 * key are two places for it to mean different things, and the diagnostics need
 * the raw value as much as the graded one.
 */
interface Declared {
  /** What the manifest holds, phrased the way a diagnostic has to say it. */
  readonly found: string;
  /** That value as one of the two words, or nothing — its own problem, never a default. */
  readonly is: Lifecycle | undefined;
}

/** The field as one of those, or nothing — which is its own problem and never a default. */
function lifecycleOf(value: unknown): Lifecycle | undefined {
  return oneOf(LIFECYCLES, value);
}

export function declaredIn(contents: ConfigObject): Declared {
  const value = contents["lifecycle"];
  return {
    found: value === undefined ? "is absent" : `reads ${JSON.stringify(value)}`,
    is: lifecycleOf(value),
  };
}

/**
 * The field only ever moves up. `dev` is where every repo starts and says
 * nothing about anyone, so anything is reachable from it; `live` says people
 * are on the other end, and that does not stop being true because a line was
 * tidied out of a manifest. Deleting it — or writing `dev` over it — sheds
 * backups, a rehearsed restore, crash reporting and the upgrade gate in one
 * edit that reviews as a whitespace change, which is the whole reason this is
 * read from the base ref rather than trusted from the tree in front of us.
 *
 * A repo really is retired sometimes, and that is a decision rather than a
 * diff: `lifecycle-retire` is where it gets written down.
 */
const READS_THE_BASE_REF =
  "the lifecycle field is compared with the base ref's, so that it cannot move back down as part of a tidy-up";

/** What the base ref says about the lifecycle, or why this checkout cannot say. */
type BaseLifecycle =
  /**
   * The commit that declared this repo `live`, abbreviated the way the
   * diagnostic names it — and nothing where the base said anything else, since
   * `dev` and an undeclared base both constrain nothing.
   */
  | { readonly liveAt: string | undefined }
  /**
   * The whole diagnostic, and what the checkout was missing. Only a shallow
   * clone and an absent ref reach here: a directory that is no repository has
   * already been refused by `manifests`, which cannot list a tree git will not
   * read.
   */
  | { readonly refused: string; readonly missing: Missing };

/**
 * The root manifest as the base ref carried it. A manifest that is not there,
 * or will not parse, declared nothing readable — and the commit carrying it
 * went through this same gate, which refuses both — so "no" is the honest
 * answer rather than a state to refuse a second time from the far side.
 */
function lifecycleIn(text: string): Lifecycle | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isObject(parsed) ? lifecycleOf(parsed["lifecycle"]) : undefined;
}

export async function lifecycleAtBase(root: string, event: Event): Promise<BaseLifecycle> {
  const base = await baseRevision(root, event, READS_THE_BASE_REF);
  if ("refused" in base) return base;
  if (base.rev === undefined) return { liveAt: undefined };

  // Relative to the working directory rather than the repository root, because
  // that is where a monorepo's project sits and where its manifest was. A path
  // the base ref did not carry fails here, which is a project this branch adds:
  // there is no earlier declaration to hold it to.
  const shown = await git(root, ["show", `${base.rev}:./package.json`]);
  const was = shown.ok ? lifecycleIn(shown.stdout) : undefined;
  return { liveAt: was === "live" ? base.rev.slice(0, 7) : undefined };
}

/**
 * The one place the field is graded — against the vocabulary, against the base
 * ref, and against the exemption that excuses the comparison. Two producers
 * would put two annotations on one deleted line, and the reader would have to
 * work out that they are the same edit.
 */
export function checkLifecycle(
  declared: Declared,
  base: BaseLifecycle,
  retiring: boolean,
): Problem[] {
  if ("refused" in base) {
    // Who cannot let this pass. A repo mid-retirement: the exemption is
    // honoured only where it can be shown to still be waiving something, and a
    // checkout that cannot answer is the door a standing waiver walks back in
    // through. A ref this run itself named: that is a broken run rather than a
    // fact about the repo, the same answer the upgrade gate gives the identical
    // condition. A `live` tree: the commit before the one that could violate
    // the rule. What is left is a `dev` repo on a shallow checkout, which never
    // needed history here and must not start failing on a depth it has always
    // been gated on.
    const refuse = retiring || base.missing === "ref" || declared.is === "live";
    if (!refuse) return notDeclared(declared);

    // The exemption is named only where it is the thing that cannot be shown:
    // no history means nobody can say whether it is still waiving anything. A
    // ref this run named and this checkout lacks refuses the same run whether
    // the exemption is there or not, so blaming the exemption for it would
    // point the reader at the wrong subject entirely.
    const message =
      retiring && base.missing === "history"
        ? `lifecycle-retire cannot be checked here: ${base.refused}`
        : base.refused;
    return [{ message }, ...notDeclared(declared)];
  }

  // The one state the exemption exists for. Waived, it is silent; unwaived, it
  // is the whole point of reading the base ref at all.
  if (base.liveAt !== undefined && declared.is !== "live") {
    return retiring
      ? notDeclared(declared)
      : [
          {
            file: "package.json",
            message: `lifecycle was "live" at ${base.liveAt} and now ${declared.found} — a repo does not stop carrying people because a field was tidied away, and everything "live" derives goes with it: backups, a rehearsed restore, crash reporting and the upgrade gate. Put it back, or name the lifecycle-retire exemption at the call site, which is what a deliberate retirement looks like.`,
          },
        ];
  }

  return [...(retiring ? [waivingNothing(base.liveAt)] : []), ...notDeclared(declared)];
}

/**
 * A `lifecycle-retire` left behind once the retirement it excused has landed.
 * Every other exemption here states something permanent about what a repo is;
 * this one states that a repo is in the middle of being wound down, which is a
 * thing that stops being true. Left in place it is a standing licence to move
 * the field back down, granted once and never reviewed again — so it has to
 * fail the moment it is waiving nothing.
 */
function waivingNothing(liveAt: string | undefined): Problem {
  const why =
    liveAt === undefined
      ? "the base ref does not declare this repo live"
      : `${liveAt} and this tree both read "live"`;
  return {
    message: `lifecycle-retire is waiving nothing — it excuses a lifecycle that has moved down from "live", and ${why}. Take it out of the call site's exemptions: a waiver that outlives what it waived is one nobody has to justify again, which is the one thing every exemption here is written not to be.`,
  };
}

/**
 * A repo that has not said which it is gets this and is graded against neither
 * set of rules: choosing for it is the choice the field exists to take away
 * from us.
 */
function notDeclared({ found, is }: Declared): Problem[] {
  if (is !== undefined) return [];
  return [
    {
      file: "package.json",
      message: `lifecycle ${found} — it says "dev" or "live", and moving it to "live" is the commit that declares this repo carries real users: from then on it owes backups, a rehearsed restore, crash reporting and the upgrade gate`,
    },
  ];
}

/**
 * Whether the repo owns a database, asked of the repo rather than of the
 * caller. `db:migrate` is the entry point every database gate here drives, so
 * a workspace that declares one owns migrations.
 *
 * Every manifest, not just the root — a monorepo keeps its migrations in the
 * workspace that owns the schema, and the root's script is a passthrough to it.
 * Asking only the root would put two edits between a live repo and no database
 * rules at all: drop the `database` input, then delete a passthrough that now
 * looks like dead weight.
 *
 * It matters that none of this is the `database` input. That input says which
 * CI job runs, and it lives in the very file the live rules are about — so
 * keying off it would let a live repo shed its backup script, its rehearsed
 * restore and its upgrade gate by deleting one line from its own workflow,
 * which is the opposite of what a contract is for.
 */
function ownsDatabase(all: readonly Manifest[]): boolean {
  return all.some(({ value }) => record(value["scripts"])["db:migrate"] !== undefined);
}

/**
 * What is at that path, or nothing when there is nothing. Absent is an answer
 * rather than a failure to every caller here — a directory that is not there, a
 * script that is not there — and absent is a different state from present and
 * wrong, which is what the callers go on to ask about.
 */
async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/**
 * The two scripts a live repo's *data* rests on, and what is on the other end
 * of each. Owed by a live repo that owns a database — a live marketing site
 * owes crash reporting and nothing here, and asking it for a backup script is
 * asking it to perform a ritual over a database it does not have.
 */
const LIVE_DATA_SCRIPTS = [
  ["scripts/backup.sh", "a systemd timer runs it, and an undumped database is one nobody has"],
  ["scripts/restore-drill.sh", "a backup nobody has restored is a backup nobody has"],
] as const;

/**
 * Sentry's SDKs are one per runtime — `@sentry/bun`, `@sentry/astro`,
 * `@sentry/tanstackstart-react`, `@sentry/react-native` — and the fact being
 * asserted is that something in this repo reports its crashes, not which of
 * them a given program reached for. So the scope is the prefix: a list of the
 * ones we happen to use today would fail the first repo on a runtime nobody had
 * thought of, which is a gate teaching a lesson about itself.
 */
const SENTRY = "@sentry/";

const EXECUTABLE = 0o111;

/**
 * The fields a package is actually shipped from. `devDependencies` declares
 * what builds and tests the repo and reaches no deployment, and
 * `peerDependencies` states what a consumer may bring — the same reasoning the
 * pin check applies in reverse. A Sentry SDK in either is a repo that does not
 * report its crashes.
 */
const SHIPPED_FIELDS = ["dependencies", "optionalDependencies"] as const;

/** Any of Sentry's per-runtime SDKs, among what a manifest actually ships. */
function hasSentry(contents: ConfigObject): boolean {
  return SHIPPED_FIELDS.some((field) =>
    Object.keys(record(contents[field])).some((name) => name.startsWith(SENTRY)),
  );
}

/**
 * What the caller's workflow asked check.yml for — the half of these rules that
 * is not read off the repo, and the only half that may be.
 */
interface Asked {
  /** The caller runs the database job, so something replays the schema. */
  readonly database: boolean;
  /** The `with:` block of the job that calls check.yml, or nothing when the call is itself a problem. */
  readonly call: ConfigObject | undefined;
}

/**
 * What `lifecycle: "live"` asserts the repo already has. Each is something the
 * day it is needed is far too late to acquire: a dump nobody took, a restore
 * nobody rehearsed, a crash nobody was told about, a migration nobody proved
 * upgrades. They are derived from the one field rather than asked for per repo,
 * so going live is one commit and not a checklist somebody works half of.
 *
 * Scoped to what the repo actually is. Crash reporting is owed by anything with
 * users; everything else here is about a database, and is owed exactly when the
 * repo owns one. A live marketing site has no database to dump, no lineage to
 * upgrade and no drill to rehearse — demanding them would teach people to write
 * a script that does nothing in order to get past a gate.
 */
export async function checkLive(
  root: string,
  all: readonly Manifest[],
  asked: Asked,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const owned = ownsDatabase(all);

  // Everything about a database is owed exactly when the repo owns one — read
  // from its own migration entry point, never from the workflow input, which
  // would let a live repo shed all three of these by deleting one line of the
  // file they are about.
  //
  // A repo that owns a schema and runs no job over it is that same hole from
  // the other side: the rules would apply and every one of them would be
  // unenforceable, since the gate proving an upgrade never runs.
  if (owned && !asked.database) {
    problems.push({
      file: CI_WORKFLOW,
      message:
        "a live repo that owns migrations must pass `database: true` to check.yml — nothing replays this schema otherwise, and the upgrade gate below has no job to run in",
    });
  }

  // The upgrade gate is here rather than beside the other workflow rules for a
  // harder reason than symmetry: check.yml *refuses* `upgrade-gate: true`
  // without `database: true`, so asking a live site with no database for it
  // would be this contract demanding the one config the shared workflow
  // rejects.
  if (owned) {
    // Read off the call rather than out of the file's text, for the reason the
    // pin is: the fact is "this job asks check.yml for the upgrade gate", and a
    // repo can spell those words in a comment, in a second job, or in a
    // workflow that calls something else entirely. Both YAML spellings count —
    // GitHub casts a quoted `"true"` to the boolean the input declares, so a
    // repo that wrote it that way is asking for the gate and getting it.
    // The `with:` block is undefined only when the call itself is already a problem.
    const gate = asked.call?.["upgrade-gate"];
    if (asked.call !== undefined && gate !== true && gate !== "true") {
      problems.push({
        file: CI_WORKFLOW,
        message:
          "a live repo's check.yml call must pass `upgrade-gate: true` — from the first deploy the migration lineage is a one-way record, and that is the gate proving an upgrade reaches the schema a rebuild does",
      });
    }

    const found = await Promise.all(
      LIVE_DATA_SCRIPTS.map(async ([path, why]) => ({
        path,
        why,
        mode: (await statOf(`${root}/${path}`))?.mode,
      })),
    );
    for (const { path, why, mode } of found) {
      if (mode === undefined) {
        problems.push({ file: path, message: `a live repo owns ${path} — ${why}` });
      } else if ((mode & EXECUTABLE) === 0) {
        problems.push({
          file: path,
          message: `${path} is not executable — chmod +x it, since it is run as a program rather than handed to an interpreter`,
        });
      }
    }
  }

  if (!all.some(({ value }) => hasSentry(value))) {
    problems.push({
      file: "package.json",
      message: `a live repo reports its crashes — declare the ${SENTRY} SDK for whatever it runs on, since a failure only the user sees is one nobody fixes`,
    });
  }

  return problems;
}
