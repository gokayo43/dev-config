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
import { readdir, readFile, stat } from "node:fs/promises";

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
  repoFiles,
} from "../_lib/gate.ts";
import { CI_WORKFLOW, type DatabaseGates } from "./ci-workflow.ts";

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
 * The entry point every database gate here drives. A repo that owns a schema
 * and does not expose this has a schema nothing replays.
 */
const MIGRATE = "db:migrate";

/**
 * The other name a migration script goes by. `db:migrate` is what this house
 * asks for; `migrate` is what drizzle-kit's own template writes and what two
 * repos on this box actually run, and a rule that only knew the first would let
 * a live repo owe nothing at all by having spelled it the common way.
 */
const ALSO_MIGRATE = "migrate";

/**
 * A schema in the tree, in the shapes this house writes one. Git pathspecs, so
 * the listing is what a scaffolder has just written as well as what is
 * committed, and `*` crosses directories — a monorepo keeps its migrations in
 * the workspace that owns them.
 */
const SCHEMA_IN_THE_TREE = [
  "*drizzle.config.*",
  "drizzle/*.sql",
  "*/drizzle/*.sql",
  "migrations/*.sql",
  "*/migrations/*.sql",
] as const;

/**
 * Whether the repo owns a database, asked of the repo rather than of the caller
 * — and asked of the *tree* rather than of a script name.
 *
 * The name alone was the hole. `db:migrate` is what this house asks for, and a
 * repo that spelled it `migrate` — drizzle-kit's own template does, and so does
 * the one live repo on this box with the most data — answered "no" and owed
 * nothing: no backups, no rehearsed restore, no upgrade gate, silently, because
 * of a colon. So the question is now asked of everything that says a schema
 * exists, and the answer names which witness found it, so a repo that genuinely
 * has no database can argue with something concrete.
 *
 * It matters that none of this is the `database` input. That input says which CI
 * gates run, and it lives in the very file the live rules are about — so keying
 * off it would let a live repo shed its backup script, its rehearsed restore and
 * its upgrade gate by deleting one line from its own workflow.
 */
async function ownsDatabase(root: string, all: readonly Manifest[]): Promise<string | undefined> {
  const named = all.find(({ value }) => {
    const scripts = record(value["scripts"]);
    return scripts[MIGRATE] !== undefined || scripts[ALSO_MIGRATE] !== undefined;
  });
  if (named !== undefined) return `${named.file} runs migrations`;
  const [found] = await repoFiles(root, SCHEMA_IN_THE_TREE);
  return found === undefined ? undefined : `${found} is a schema this repo migrates`;
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
 * The two scheduled jobs a live repo's *data* rests on, and what is on the
 * other end of each. Owed by a live repo that owns a database — a live
 * marketing site owes crash reporting and nothing here, and asking it for a
 * backup script is asking it to perform a ritual over a database it does not
 * have.
 *
 * A job is three files, not one. The script is what runs; a `.timer` and the
 * `.service` it activates are what "periodically" means on the box these repos
 * are deployed to, and they are tracked so the schedule is something a diff can
 * be reviewed against rather than a fact only `systemctl` holds. What the repo
 * cannot say is whether that timer is enabled — a `systemctl enable --now`
 * nobody can read out of a checkout, and docs/gates/repo-contract.md names it as
 * the owner's step.
 */
const LIVE_DATA_JOBS = [
  ["backup", "an undumped database is one nobody has"],
  ["restore-drill", "a backup nobody has restored is a backup nobody has"],
] as const;

/**
 * The input that says these jobs are somebody else's, and where. Named in the
 * diagnostic rather than left to be discovered, because a repo whose backups
 * genuinely run outside it has no way to guess that the way out is an input at
 * the call site.
 */
const DATA_JOBS_EXTERNAL = "data-jobs-external";

/**
 * The directives that make a timer fire more than once. `OnBootSec` is not
 * among them on purpose: a unit that runs once per boot is a startup task, and
 * a box that stays up for a month runs it once — which is the state a backup
 * and a rehearsed restore both exist to rule out.
 */
const RECURRING: readonly string[] = ["OnCalendar", "OnUnitActiveSec"];

const TIMER = ".timer";
const SERVICE = ".service";

/** One `Key=value` line of a unit file. */
interface Directive {
  readonly key: string;
  readonly value: string;
}

/** A unit file as systemd reads it: every directive under the section it was written in. */
type Unit = ReadonlyMap<string, readonly Directive[]>;

/**
 * The section matters rather than decorates: systemd reads `WantedBy` only
 * under `[Install]`, and the same line under `[Timer]` is silently nothing —
 * which is exactly the unit that looks enabled in a diff and refuses
 * `systemctl enable` on the box.
 *
 * Parsed whole, once, because three questions are asked of one file and a scan
 * per question is where three answers start disagreeing about what a comment is.
 */
function sectionsOf(text: string): Unit {
  const sections = new Map<string, Directive[]>();
  let current: Directive[] | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      current = sections.get(line.slice(1, -1)) ?? [];
      sections.set(line.slice(1, -1), current);
      continue;
    }
    if (current === undefined || line.startsWith("#") || line.startsWith(";")) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    current.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return sections;
}

function under(unit: Unit, section: string): readonly Directive[] {
  return unit.get(section) ?? [];
}

/** One `ExecStart=` as systemd would run it: the program, and every word of it. */
interface Command {
  /** The first word, with systemd's prefixes and any quoting taken off. */
  readonly program: string;
  /** Every word, so a script named as an *argument* can be told from one that is run. */
  readonly words: readonly string[];
}

/**
 * systemd's prefix characters sit before the path and say how to run the
 * command — ignore a failure, pass a different argv[0], adjust privileges —
 * rather than what it is.
 */
function unprefixed(word: string): string {
  return word.replace(/^[-@+!:]+/, "").replaceAll(/^["']|["']$/g, "");
}

/**
 * What a service actually runs.
 *
 * The first word is the program and everything after it is arguments, which is
 * the whole difference between a unit that runs the script and one that only
 * mentions it: `env WRAPPED=backup.sh /usr/bin/true` names it and never
 * executes it, and `/bin/sh -c '…/backup.sh'` runs a shell. An empty
 * `ExecStart=` is the list reset, so a unit that sets one after its command runs
 * nothing at all.
 *
 * A path with a space in it would need systemd's own quoting rules to read, and
 * is not a name any checkout in this house has; the cost of being wrong about
 * one is a refusal that names the file it read.
 */
function commandsOf(unit: Unit): Command[] {
  let commands: Command[] = [];
  for (const { key, value } of under(unit, "Service")) {
    if (key !== "ExecStart") continue;
    if (value === "") {
      commands = [];
      continue;
    }
    const words = value.split(/\s+/).map(unprefixed);
    commands.push({ program: words[0] ?? "", words });
  }
  return commands;
}

/**
 * Whether this program *is* the repo's own script.
 *
 * The trailing path segments, because a checkout cannot know where it will be
 * deployed: the unit on the box says `/opt/postpad/scripts/backup.sh` and the
 * gate is looking at `/home/runner/work/postpad/postpad`. So `scripts/<job>.sh`
 * as whole segments is the most a checkout can honestly assert — which refuses
 * `/usr/local/bin/backup.sh` and `pre-backup.sh`, and cannot by itself refuse
 * another stack's copy of the same relative path. What catches *that* is the
 * two jobs having to agree about where this repo lives; see `deployedAt`.
 */
function isScript(program: string, script: string): boolean {
  const written = program.replace(/^\.\//, "");
  return written === script || written.endsWith(`/${script}`);
}

/**
 * The directory a unit runs this repo out of — everything before `scripts/`.
 * Two jobs pointing at different ones is a unit copied from the stack next door,
 * which is the one wrong-location mistake a checkout can actually catch.
 */
function deployedAt(program: string): string {
  return program.slice(0, program.lastIndexOf("/scripts/") + 1);
}

/**
 * Everything under `scripts/`, sorted, or nothing where the directory is not
 * there — which is a live repo that owns a database and has written none of
 * this yet, and is told so by name a few lines later. Reading it before that
 * point is what makes the empty answer real rather than defensive.
 */
async function scriptsIn(root: string): Promise<string[]> {
  try {
    return (await readdir(`${root}/scripts`)).toSorted();
  } catch {
    return [];
  }
}

/** One unit file, parsed. Named by the listing above, so a read that fails is that same broken run. */
async function unitAt(path: string): Promise<Unit> {
  return sectionsOf(await readFile(path, "utf8"));
}

/** The stem shared by a unit pair — `postpad-backup` for `postpad-backup.timer`. */
function stemsOf(entries: readonly string[], suffix: string): string[] {
  return entries
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => entry.slice(0, -suffix.length));
}

/**
 * Whether this timer would ever fire, and whether anyone could turn it on. Two
 * facts rather than the file's existence: a unit that satisfies neither is
 * committed decoration, which is worse than an absent one — it reads, in every
 * later diff, as a job somebody set up.
 */
function checkTimer(stem: string, timer: Unit): Problem[] {
  const path = `scripts/${stem}${TIMER}`;
  const problems: Problem[] = [];
  if (!under(timer, "Timer").some(({ key }) => RECURRING.includes(key))) {
    problems.push({
      file: path,
      message: `${path} sets no ${RECURRING.join("= or ")}= under [Timer] — give it a recurring schedule, since a timer that fires once is the run somebody did by hand`,
    });
  }
  if (!under(timer, "Install").some(({ key }) => key === "WantedBy")) {
    problems.push({
      file: path,
      message: `${path} has no WantedBy= under [Install] — add \`WantedBy=timers.target\`, since systemctl enable refuses a unit with no install section and this timer cannot be turned on until it has one`,
    });
  }
  return problems;
}

/**
 * Which service a timer activates. Its own stem by default, and whatever
 * `[Timer] Unit=` names when it names one — a timer pointed at another unit is
 * a pairing systemd honours, so a gate that only knew about matching stems
 * would call a working schedule missing.
 */
function activates(stem: string, timer: Unit): string {
  const named = under(timer, "Timer").find(({ key }) => key === "Unit")?.value;
  if (named === undefined || named === "") return stem;
  return named.endsWith(SERVICE) ? named.slice(0, -SERVICE.length) : named;
}

/** One service under `scripts/`, parsed, with the stem it was filed under. */
interface Service {
  readonly stem: string;
  readonly commands: readonly Command[];
}

/**
 * What is wrong with a service that mentions the script without running it —
 * or nothing, where it does run it or does not mention it at all. Each of these
 * is a unit somebody wrote on purpose, so each gets a sentence of its own
 * rather than the "nothing runs it" that is true of a repo with no units.
 */
function misruns({ stem, commands }: Service, script: string, name: string): string | undefined {
  const path = `scripts/${stem}${SERVICE}`;
  const wrapped = commands.find(({ words }) =>
    words.slice(1).some((word) => isScript(word, script)),
  );
  if (wrapped !== undefined) {
    return `${path} runs ${wrapped.program} with ${script} as an argument — the program has to be the script itself, since a shell in between is what decides the exit status systemd reads`;
  }
  const elsewhere = commands.find(({ program }) => program.endsWith(`/${name}.sh`));
  if (elsewhere !== undefined) {
    return `${path} runs ${elsewhere.program}, which is not this repo's ${script} — a unit naming a copy somewhere else on the box is a schedule for somebody else's data`;
  }
  return undefined;
}

/**
 * Drop-in directories, which systemd merges over a unit and this gate does not
 * read. A repo that put its schedule in one has a schedule no diff of the unit
 * file shows.
 *
 * Asked of the directory once rather than of each job: a drop-in is one mistake,
 * and reporting it per job would put two annotations on one edit.
 */
function dropIns(entries: readonly string[]): Problem[] {
  return entries
    .filter((entry) => entry.endsWith(`${TIMER}.d`) || entry.endsWith(`${SERVICE}.d`))
    .map((entry) => ({
      file: `scripts/${entry}`,
      message: `scripts/${entry} is a drop-in directory, and this gate reads only the unit file it would be merged over — put the schedule in the unit itself, since a fact split across two files is one a diff of either does not show`,
    }));
}

/** What a job's units came to: what is wrong with them, and where they say the repo lives. */
interface Scheduled {
  readonly problems: Problem[];
  /** The directory a working pair runs the script out of, where one was found. */
  readonly root: string | undefined;
}

/**
 * The pair that puts this job on a schedule, found through what a service
 * *runs* rather than through what it is called.
 *
 * The name cannot be the fact. systemd's unit namespace is the whole box, so
 * every stack deployed beside another prefixes — `/opt/postpad/scripts/` holds
 * `postpad-backup.timer` — and a gate demanding `backup.timer` would be one no
 * repo on this box could satisfy while remaining installable.
 *
 * More than one pair may run one script, a nightly and a weekly say, and the
 * job is scheduled if any of them schedules it. Where none does, the first is
 * the one whose problems are reported: a diagnostic that named every candidate
 * would be a list to work through instead of a file to fix.
 */
async function checkUnits(
  root: string,
  entries: readonly string[],
  name: string,
): Promise<Scheduled> {
  const script = `scripts/${name}.sh`;
  const services = new Map<string, Service>(
    await Promise.all(
      stemsOf(entries, SERVICE).map(async (stem): Promise<[string, Service]> => [
        stem,
        { stem, commands: commandsOf(await unitAt(`${root}/scripts/${stem}${SERVICE}`)) },
      ]),
    ),
  );
  const timers = await Promise.all(
    stemsOf(entries, TIMER).map(async (stem) => {
      const timer = await unitAt(`${root}/scripts/${stem}${TIMER}`);
      return { stem, timer, service: services.get(activates(stem, timer)) };
    }),
  );

  const runs = (service: Service | undefined): Command | undefined =>
    service?.commands.find(({ program }) => isScript(program, script));

  const pairs = timers.filter(({ service }) => runs(service) !== undefined);
  const problems: Problem[] = [];

  if (pairs.length === 0) {
    // A service that does run it, with no timer pointing at it: the unit exists
    // and only ever runs by hand.
    const orphaned = [...services.values()].find((service) => runs(service) !== undefined);
    if (orphaned !== undefined) {
      return {
        problems: [
          ...problems,
          {
            file: `scripts/${orphaned.stem}${SERVICE}`,
            message: `scripts/${orphaned.stem}${SERVICE} runs ${name}.sh and no timer under scripts/ activates it — add one beside it, or point an existing timer at it with \`Unit=\`, since a service nothing activates only ever runs by hand`,
          },
        ],
        root: undefined,
      };
    }
    // A unit that mentions the script and does not run it, which is a mistake
    // with a name rather than an absence.
    const wrong = [...services.values()]
      .map((service) => misruns(service, script, name))
      .find((said) => said !== undefined);
    return {
      problems: [
        ...problems,
        {
          file: wrong === undefined ? script : "scripts",
          message:
            wrong ??
            `nothing in scripts/ runs ${script} on a schedule — commit a .timer and the .service it activates, under whatever name this repo uses (systemd's unit namespace is the whole box, so \`<repo>-${name}\` is the usual spelling), since a script nothing runs on a schedule is one that ran the day it was written`,
        },
      ],
      root: undefined,
    };
  }

  const graded = pairs.map(({ stem, timer }) => checkTimer(stem, timer));
  const working = graded.findIndex((each) => each.length === 0);
  const found = pairs[working === -1 ? 0 : working];
  return {
    problems: [...problems, ...(working === -1 ? (graded[0] ?? []) : [])],
    root: working === -1 ? undefined : deployedAt(runs(found?.service)?.program ?? ""),
  };
}

/**
 * One scheduled job, whole: the program, and the units that make it periodic.
 * Both halves in one place because "the script is there and nothing runs it" is
 * one finding about one job rather than two findings that happen to share a name.
 */
async function checkJob(
  root: string,
  entries: readonly string[],
  name: string,
  why: string,
): Promise<Scheduled> {
  const script = `scripts/${name}.sh`;
  const mode = (await statOf(`${root}/${script}`))?.mode;
  if (mode === undefined) {
    return {
      problems: [
        {
          file: script,
          message: `a live repo owns ${script} — ${why}. Where the deployment already runs this job outside the repo, name it in \`${DATA_JOBS_EXTERNAL}\` at the call site instead: a second copy on a second schedule is two answers to when this data is dumped.`,
        },
      ],
      root: undefined,
    };
  }
  const problems: Problem[] =
    (mode & EXECUTABLE) === 0
      ? [
          {
            file: script,
            message: `${script} is not executable — chmod +x it, since it is run as a program rather than handed to an interpreter`,
          },
        ]
      : [];
  const scheduled = await checkUnits(root, entries, name);
  return { problems: [...problems, ...scheduled.problems], root: scheduled.root };
}

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
  /** Which database gates the call runs — `none` is the one value under which nothing replays the schema. */
  readonly database: DatabaseGates;
  /** The `with:` block of the job that calls check.yml, or nothing when the call is itself a problem. */
  readonly call: ConfigObject | undefined;
  /**
   * Where the deployment runs this repo's backup and restore drill, when they
   * are not this repo's own scripts. The reason **is** the waiver: there is no
   * spelling of it that claims the exemption without naming the jobs, which is
   * the difference between an exception a reviewer can check and a switch.
   */
  readonly dataJobsExternal: string;
}

/**
 * The two scheduled jobs, or the statement that they are somebody else's.
 *
 * The waiver exists because the rule can be satisfied dishonestly. A repo whose
 * deployment already dumps its database on a schedule — a whole-box borg job
 * under root's crontab, with binlog shipping beside it — can only pass the rule
 * as written by committing a *second* backup of the same data on a *second*
 * schedule, reviewed and enabled separately. That is two answers to "when is
 * this dumped", which is the failure this rule exists to prevent, reached from
 * the other side. So the way out is to say where the real ones run.
 *
 * The reason IS the waiver rather than a switch beside one: an empty value is
 * not an exemption at all, so there is no spelling that claims it without naming
 * the jobs, and a reviewer always has the thing to check. `test-network` is the
 * same shape for the same reason.
 *
 * And it has to still be waiving something. A repo that names external jobs and
 * commits one of these scripts anyway has exactly the duplicate the waiver was
 * granted to avoid — so that is refused rather than quietly preferred one way
 * or the other, the way `lifecycle-retire` is refused once it waives nothing.
 */
async function checkDataJobs(root: string, external: string): Promise<Problem[]> {
  const entries = await scriptsIn(root);
  if (external !== "") {
    return LIVE_DATA_JOBS.filter(([name]) => entries.includes(`${name}.sh`)).map(([name]) => ({
      file: `scripts/${name}.sh`,
      message: `${DATA_JOBS_EXTERNAL} says this repo's data jobs run outside it — "${external}" — and scripts/${name}.sh is one of them committed here anyway. One of the two is the schedule nobody reads: keep the external jobs and delete this, or drop the input and own them here.`,
    }));
  }

  const problems: Problem[] = [...dropIns(entries)];
  const jobs = await Promise.all(
    LIVE_DATA_JOBS.map(async ([name, why]) => await checkJob(root, entries, name, why)),
  );
  problems.push(...jobs.flatMap(({ problems: each }) => each));

  // The one wrong location a checkout can catch. A unit copied from the stack
  // next door keeps its neighbour's path, and the two jobs then disagree about
  // where this repo lives — which nothing else here can see, since a checkout
  // has no idea what directory it will be deployed into.
  const roots = [...new Set(jobs.map(({ root: at }) => at).filter((at) => at !== undefined))];
  if (roots.length > 1) {
    problems.push({
      file: "scripts",
      message: `the data jobs' units disagree about where this repo is deployed — ${roots.join(" and ")} — so at least one of them is scheduling another stack's copy of the script`,
    });
  }
  return problems;
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
  const owned = await ownsDatabase(root, all);

  // Everything about a database is owed exactly when the repo owns one — read
  // from its own migration entry point, never from the workflow input, which
  // would let a live repo shed all three of these by deleting one line of the
  // file they are about.
  //
  // A repo that owns a schema and runs no gate over it is that same hole from
  // the other side: the rules would apply and every one of them would be
  // unenforceable, since the gate proving an upgrade never runs.
  //
  // `external` satisfies this and `none` does not, which is the whole of the
  // difference between them: a wrapper workflow that replaced check.yml's
  // Postgres job with its own dialect's does replay the schema, and refusing
  // its consumers was refusing them for a job somebody had deliberately taken
  // over.
  if (owned !== undefined && asked.database === "none") {
    problems.push({
      file: CI_WORKFLOW,
      message: `a live repo that owns migrations must pass \`database: postgres\` — or \`database: external\`, where a wrapper workflow runs the database gates — to check.yml: ${owned}, nothing replays it otherwise, and the upgrade gate below has no job to run in`,
    });
  }

  // The upgrade gate is here rather than beside the other workflow rules for a
  // harder reason than symmetry: check.yml *refuses* `upgrade-gate: true`
  // without `database: postgres`, so asking a live site with no database for it
  // would be this contract demanding the one config the shared workflow
  // rejects. `external` is that same state and the only other one — the upgrade
  // gate this input names belongs to the Postgres job, and a call that has
  // replaced that job has no such gate to ask for; the wrapper that did is what
  // owes its consumers one. `none` still answers for it, since the finding
  // beside it is what puts that call back on a job.
  if (owned !== undefined) {
    // Read off the call rather than out of the file's text, for the reason the
    // pin is: the fact is "this job asks check.yml for the upgrade gate", and a
    // repo can spell those words in a comment, in a second job, or in a
    // workflow that calls something else entirely. Both YAML spellings count —
    // GitHub casts a quoted `"true"` to the boolean the input declares, so a
    // repo that wrote it that way is asking for the gate and getting it.
    // The `with:` block is undefined only when the call itself is already a problem.
    const gate = asked.call?.["upgrade-gate"];
    if (
      asked.database !== "external" &&
      asked.call !== undefined &&
      gate !== true &&
      gate !== "true"
    ) {
      problems.push({
        file: CI_WORKFLOW,
        message:
          "a live repo's check.yml call must pass `upgrade-gate: true` — from the first deploy the migration lineage is a one-way record, and that is the gate proving an upgrade reaches the schema a rebuild does",
      });
    }

    problems.push(...(await checkDataJobs(root, asked.dataJobsExternal.trim())));
  }

  if (!all.some(({ value }) => hasSentry(value))) {
    problems.push({
      file: "package.json",
      message: `a live repo reports its crashes — declare the ${SENTRY} SDK for whatever it runs on, since a failure only the user sees is one nobody fixes`,
    });
  }

  return problems;
}
