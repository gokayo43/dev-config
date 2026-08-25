/**
 * The half of the contract that grades what having users costs: the
 * `lifecycle` field, and everything the word "live" derives — a dump nobody
 * took, a restore nobody rehearsed, a crash nobody was told about, a migration
 * nobody proved upgrades.
 *
 * Its own file for the reason `live.ts` is its own module: one word deciding
 * whether a whole rule set applies is a different subject from the facts every
 * repo satisfies whether or not anyone is on the other end, and a new live rule
 * should read as a rule rather than as a change to the contract.
 * `repo-contract-fixture.ts` is the clean tree both files start from.
 */
import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import type { Event } from "../.github/actions/_lib/gate.ts";
import { type Contract, repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { containing } from "./matchers.ts";
import {
  CLEAN,
  contract,
  DEFAULTS,
  manifestWith,
  type PackageJson,
  PIN,
} from "./repo-contract-fixture.ts";
import { git, history, materialise, type Tree, under, without } from "./tree.ts";

const BACKUP = "scripts/backup.sh";
const RESTORE_DRILL = "scripts/restore-drill.sh";

/**
 * The unit files a live repo carries, under the names the deployed repos
 * actually use. systemd's unit namespace is the whole box, so every stack on it
 * prefixes — `/opt/postpad/scripts/` holds `postpad-backup.timer`, not
 * `backup.timer` — and a fixture spelled the short way would be this suite
 * agreeing with a rule the fleet cannot satisfy.
 */
const UNITS = "clean-";

/** A timer that repeats and can be enabled, which is the pair of facts one is graded on. */
function timerUnit(stem: string): string {
  return `[Unit]\nDescription=${stem}\n\n[Timer]\nOnCalendar=*-*-* 04:10:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
}

/** The service a timer of the same stem activates, running `command`. */
function serviceUnit(stem: string, command: string): string {
  return `[Unit]\nDescription=${stem}\n\n[Service]\nType=oneshot\nExecStart=${command}\n`;
}

/** The two files that make one job scheduled, under whatever stem the repo picked. */
function unitsFor(
  job: string,
  stem = `${UNITS}${job}`,
  command = `/opt/clean/scripts/${job}.sh`,
): Tree {
  return {
    [`scripts/${stem}.timer`]: timerUnit(stem),
    [`scripts/${stem}.service`]: serviceUnit(stem, command),
  };
}

/** Everything `lifecycle: "live"` derives, all of it satisfied. */
const LIVE: Tree = {
  ...manifestWith((contents) => {
    contents.lifecycle = "live";
    contents.dependencies = { "@sentry/bun": "10.24.0" };
  }),
  [BACKUP]: "#!/usr/bin/env bash\n",
  [RESTORE_DRILL]: "#!/usr/bin/env bash\n",
  ...unitsFor("backup"),
  ...unitsFor("restore-drill"),
  ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n    with:\n      database: postgres\n      upgrade-gate: true\n`,
};

/**
 * The same materialisation, with the two scripts marked executable — the state
 * git records and a systemd unit needs. Bun.write leaves a new file at the
 * umask's 0644, which is exactly the tree the not-executable case wants.
 */
async function live(
  tree: Tree,
  { executable = [BACKUP, RESTORE_DRILL], ...overrides }: LiveOptions = {},
): Promise<string[]> {
  const root = await materialise(tree, [".env.example"]);
  await Promise.all(
    executable.filter((path) => path in tree).map((path) => chmod(join(root, path), 0o755)),
  );
  return (await repoContract(root, { ...DEFAULTS, ...overrides })).map(({ message }) => message);
}

interface LiveOptions extends Partial<Contract> {
  readonly executable?: readonly string[];
}

/**
 * The manifest a live static site ships, and whatever a case changes about it.
 * Stated once: the lifecycle cases below differ from this tree by one field,
 * and rebuilding the other three around each of them is how two definitions of
 * "a live static repo" start disagreeing about which fault a case is showing.
 */
function liveManifest(change: (contents: PackageJson) => void = () => {}): Tree {
  return manifestWith((contents) => {
    contents.lifecycle = "live";
    contents.dependencies = { "@sentry/astro": "10.24.0" };
    delete contents.scripts?.["db:migrate"];
    change(contents);
  });
}

/** A live repo with no database of its own: a marketing site, and half the fleet. */
const LIVE_STATIC: Tree = {
  ...without(without(liveManifest(), BACKUP), RESTORE_DRILL),
  ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n`,
};

// The field is the switch, so a repo that has not thrown it is graded against
// neither set of rules — the gate says only that nobody has said which repo
// this is.
describe("the lifecycle field", () => {
  test("a repo that does not declare one is refused", async () => {
    expect(await contract(manifestWith((contents) => delete contents.lifecycle))).toEqual([
      containing("lifecycle is absent"),
    ]);
  });

  test.each(["prod", "", "production", "Live", "true"])(
    "a lifecycle nobody defined (%s) is refused rather than read as either",
    async (value) => {
      expect(await contract(manifestWith((contents) => (contents.lifecycle = value)))).toEqual([
        containing(`lifecycle reads ${JSON.stringify(value)}`),
      ]);
    },
  );

  // Each row is the argument list, so the array case is a row of one array —
  // written flat it would be spread into the string "live" and test the opposite.
  test.each([[true], [1], [null], [["live"]]])(
    "a lifecycle that is not even a string (%p) is refused, not crashed on",
    async (value: unknown) => {
      expect(await contract(manifestWith((contents) => (contents["lifecycle"] = value)))).toEqual([
        containing('it says "dev" or "live"'),
      ]);
    },
  );

  test("a dev repo owes none of what going live requires", async () => {
    // The clean tree has no backup script, no restore drill, no Sentry and no
    // upgrade gate, and that is a complete repo until the day it is deployed.
    expect(await contract(CLEAN)).toEqual([]);
  });

  test("a live repo that has all of it passes", async () => {
    expect(await live(LIVE)).toEqual([]);
  });
});

describe("what going live requires", () => {
  test("CI has to ask check.yml for the upgrade gate", async () => {
    expect(
      await live({ ...LIVE, ".github/workflows/ci.yml": CLEAN[".github/workflows/ci.yml"] ?? "" }),
    ).toEqual([containing("must pass `upgrade-gate: true`")]);
  });

  // GitHub casts it to the boolean the input declares, so the repo asking this
  // way is a repo running the gate.
  test("the quoted spelling asks for it too", async () => {
    const quoted = (LIVE[".github/workflows/ci.yml"] ?? "").replace(
      "upgrade-gate: true",
      'upgrade-gate: "true"',
    );
    expect(await live({ ...LIVE, ".github/workflows/ci.yml": quoted })).toEqual([]);
  });

  test("an upgrade-gate on a job that calls something else is not the call's", async () => {
    const elsewhere = `${LIVE[".github/workflows/ci.yml"] ?? ""}  other:\n    uses: someone/else/.github/workflows/check.yml@${PIN}\n    with:\n      upgrade-gate: true\n`;
    const off = elsewhere.replace(
      "      database: postgres\n      upgrade-gate: true\n",
      "      database: postgres\n",
    );
    expect(await live({ ...LIVE, ".github/workflows/ci.yml": off })).toEqual([
      containing("must pass `upgrade-gate: true`"),
    ]);
  });

  test.each([
    [BACKUP, "a live repo owns scripts/backup.sh"],
    [RESTORE_DRILL, "a live repo owns scripts/restore-drill.sh"],
  ])("%s has to exist", async (path, message) => {
    expect(await live(without(LIVE, path))).toEqual([containing(message)]);
  });

  // A script systemd execs directly, committed without its bit, fails at 3am
  // and not before.
  test.each([BACKUP, RESTORE_DRILL])("%s has to be executable", async (path) => {
    const executable = [BACKUP, RESTORE_DRILL].filter((each) => each !== path);
    expect(await live(LIVE, { executable })).toEqual([containing(`${path} is not executable`)]);
  });

  // A script is the program; the two units beside it are what "periodically"
  // means, and canon says a backup nobody has restored is a backup nobody has.
  // What is graded is the PAIR, never the filename: systemd's unit namespace is
  // the whole box, so a repo that named its units after the script alone could
  // not be deployed beside a second repo that did the same.
  describe("a live repo's data scripts each carry the units that run them", () => {
    const JOBS = ["backup", "restore-drill"];

    // The clean tree already proves this, since every unit in it is prefixed.
    // Stated again from the other side: the short spelling is not privileged.
    test("the units are named by the repo, not by this gate", async () => {
      const named: Tree = {
        ...without(without(LIVE, "scripts/clean-backup.timer"), "scripts/clean-backup.service"),
        ...unitsFor("backup", "nightly-dump"),
      };
      expect(await live(named)).toEqual([]);
    });

    test.each(JOBS)("%s has to have a pair at all", async (job) => {
      const bare = without(
        without(LIVE, `scripts/${UNITS}${job}.timer`),
        `scripts/${UNITS}${job}.service`,
      );
      expect(await live(bare)).toEqual([
        containing(`nothing in scripts/ runs scripts/${job}.sh on a schedule`),
      ]);
    });

    // A service with no timer of its own stem is a unit that only ever runs by
    // hand, which is the state the whole rule exists to rule out.
    test.each(JOBS)("%s's service without its timer is refused", async (job) => {
      expect(await live(without(LIVE, `scripts/${UNITS}${job}.timer`))).toEqual([
        containing(
          `scripts/${UNITS}${job}.service runs ${job}.sh and no timer under scripts/ activates it`,
        ),
      ]);
    });

    // The pair is found through what the service execs, so a timer whose
    // sibling runs something else is not this job's.
    test("a pair that runs something else is not this job's", async () => {
      const elsewhere: Tree = {
        ...LIVE,
        ...unitsFor("restore-drill", `${UNITS}restore-drill`, "/opt/clean/scripts/backup.sh"),
      };
      expect(await live(elsewhere)).toEqual([
        containing("nothing in scripts/ runs scripts/restore-drill.sh on a schedule"),
      ]);
    });

    // `.includes()` on the ExecStart value calls both of these a match, and
    // neither runs the script: the first is a different program whose name ends
    // the same way, the second never executes it at all.
    test.each([
      ["/opt/clean/scripts/pre-backup.sh", "a different script whose name ends the same way"],
      [
        "/usr/bin/env WRAPPED=backup.sh /usr/bin/true",
        "the script's name as an argument, not as the program",
      ],
    ])("an ExecStart of %p is not running backup.sh (%s)", async (command) => {
      const decoy: Tree = { ...LIVE, ...unitsFor("backup", `${UNITS}backup`, command) };
      expect(await live(decoy)).toEqual([
        containing("nothing in scripts/ runs scripts/backup.sh on a schedule"),
      ]);
    });

    // The path is the fact, not the file name at the end of it. A checkout
    // cannot know where it will be deployed, so what it can assert is the
    // trailing segments — which is enough to refuse a program that is not this
    // repo's script at all.
    test.each([
      ["/usr/local/bin/backup.sh", "a program of the same name somewhere on PATH"],
      ["/opt/clean/lib/backup.sh", "the same name outside scripts/"],
    ])("an ExecStart of %p is not this repo's script (%s)", async (command) => {
      const wrong: Tree = { ...LIVE, ...unitsFor("backup", `${UNITS}backup`, command) };
      expect(await live(wrong)).toEqual([containing("which is not this repo's scripts/backup.sh")]);
    });

    // A shell in between is what decides the exit status systemd reads, so a
    // failing drill can come back green.
    test("a shell running the script is not the script", async () => {
      const wrapped: Tree = {
        ...LIVE,
        ...unitsFor("backup", `${UNITS}backup`, "/bin/sh -c /opt/clean/scripts/backup.sh"),
      };
      expect(await live(wrapped)).toEqual([
        containing("runs /bin/sh with scripts/backup.sh as an argument"),
      ]);
    });

    // What a checkout can catch about a unit copied from the stack next door:
    // the two jobs stop agreeing about where this repo lives.
    test("units that disagree about where the repo is deployed are refused", async () => {
      const mixed: Tree = {
        ...LIVE,
        ...unitsFor(
          "restore-drill",
          `${UNITS}restore-drill`,
          "/opt/other-stack/scripts/restore-drill.sh",
        ),
      };
      expect(await live(mixed)).toEqual([containing("disagree about where this repo is deployed")]);
    });

    // systemd merges a drop-in over the unit; this gate reads only the unit, so
    // a schedule hidden in one is a schedule no diff of the unit shows.
    test("a drop-in directory is refused rather than read", async () => {
      const dropped: Tree = {
        ...LIVE,
        [`scripts/${UNITS}backup.timer.d/schedule.conf`]: "[Timer]\nOnCalendar=daily\n",
      };
      expect(await live(dropped)).toEqual([containing("is a drop-in directory")]);
    });

    // `[Timer] Unit=` is a pairing systemd honours, so a gate that only matched
    // stems would call a working schedule missing.
    test("a timer pointed at another unit with Unit= is honoured", async () => {
      const crossed: Tree = {
        ...without(LIVE, `scripts/${UNITS}backup.timer`),
        [`scripts/nightly.timer`]: timerUnit("nightly").replace(
          "[Timer]",
          `[Timer]\nUnit=${UNITS}backup.service`,
        ),
      };
      expect(await live(crossed)).toEqual([]);
    });

    // systemd reads `-@+!:` before the path as flags on how to run it, so a unit
    // spelled that way is running exactly this script.
    test.each(["-", "@", "+", "!", "-@", "!!"])(
      "an ExecStart prefixed with %p still runs the script",
      async (prefix) => {
        const flagged: Tree = {
          ...LIVE,
          ...unitsFor("backup", `${UNITS}backup`, `${prefix}/opt/clean/scripts/backup.sh --quiet`),
        };
        expect(await live(flagged)).toEqual([]);
      },
    );

    // An empty ExecStart= is systemd's list reset, so a unit that sets one after
    // its command execs nothing at all.
    test("an ExecStart list reset leaves nothing running", async () => {
      const reset = `[Unit]\nDescription=x\n\n[Service]\nType=oneshot\nExecStart=/opt/clean/scripts/backup.sh\nExecStart=\n`;
      expect(await live({ ...LIVE, [`scripts/${UNITS}backup.service`]: reset })).toEqual([
        containing("nothing in scripts/ runs scripts/backup.sh on a schedule"),
      ]);
    });

    // The box these deploy to already carries a timer pair per stack that is
    // neither of these jobs.
    test("a timer pair for something else entirely is ignored", async () => {
      const alongside: Tree = { ...LIVE, ...unitsFor("healthcheck", `${UNITS}healthcheck`) };
      expect(await live(alongside)).toEqual([]);
    });

    // The file existing is not the fact. A timer with no recurring schedule is
    // the run somebody did by hand, committed.
    test("a timer with no recurring schedule is refused", async () => {
      const once =
        "[Unit]\nDescription=x\n\n[Timer]\nOnBootSec=5min\n\n[Install]\nWantedBy=timers.target\n";
      expect(await live({ ...LIVE, [`scripts/${UNITS}backup.timer`]: once })).toEqual([
        containing("sets no OnCalendar= or OnUnitActiveSec= under [Timer]"),
      ]);
    });

    // systemd reads a directive only under the section it belongs to, so a gate
    // that greps the whole file passes a unit that does nothing.
    test("a schedule written outside [Timer] is not a schedule", async () => {
      const misfiled =
        "[Unit]\nDescription=x\nOnCalendar=*-*-* 04:10:00\n\n[Timer]\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n";
      expect(await live({ ...LIVE, [`scripts/${UNITS}backup.timer`]: misfiled })).toEqual([
        containing("sets no OnCalendar= or OnUnitActiveSec= under [Timer]"),
      ]);
    });

    test("a commented-out schedule is not a schedule", async () => {
      const off =
        "[Unit]\nDescription=x\n\n[Timer]\n# OnCalendar=*-*-* 04:10:00\n\n[Install]\nWantedBy=timers.target\n";
      expect(await live({ ...LIVE, [`scripts/${UNITS}backup.timer`]: off })).toEqual([
        containing("sets no OnCalendar= or OnUnitActiveSec= under [Timer]"),
      ]);
    });

    // `systemctl enable` refuses a unit with no [Install], so a timer without one
    // is a schedule nobody can turn on.
    test("a timer that cannot be enabled is refused", async () => {
      const stuck = "[Unit]\nDescription=x\n\n[Timer]\nOnCalendar=*-*-* 04:10:00\n";
      expect(await live({ ...LIVE, [`scripts/${UNITS}backup.timer`]: stuck })).toEqual([
        containing("has no WantedBy= under [Install]"),
      ]);
    });

    test("a WantedBy written outside [Install] does not enable anything", async () => {
      const misfiled =
        "[Unit]\nDescription=x\n\n[Timer]\nOnCalendar=*-*-* 04:10:00\nWantedBy=timers.target\n";
      expect(await live({ ...LIVE, [`scripts/${UNITS}backup.timer`]: misfiled })).toEqual([
        containing("has no WantedBy= under [Install]"),
      ]);
    });

    // More than one pair can run the same script — a nightly and a weekly, say
    // — and the job is scheduled if any of them schedules it.
    test("one good pair among several is enough", async () => {
      const both: Tree = { ...LIVE, ...unitsFor("backup", "weekly-dump") };
      const broken = "[Unit]\nDescription=x\n\n[Timer]\nOnCalendar=*-*-* 04:10:00\n";
      expect(await live({ ...both, [`scripts/${UNITS}backup.timer`]: broken })).toEqual([]);
    });
  });

  // What a repo owns is a fact of its tree, not of a script name. postpad calls
  // the same script `migrate`, and under a rule keyed on `db:migrate` that
  // spelling made it owe nothing at all: no backups, no rehearsed restore, no
  // upgrade gate, silently, because of a colon.
  test.each([
    ["scripts", { migrate: "drizzle-kit migrate" }, undefined],
    ["a drizzle config anywhere in the tree", {}, "packages/database/drizzle.config.ts"],
    ["a migration in the tree", {}, "drizzle/0000_init.sql"],
  ])("a live repo that owns a database by %s owes all of it", async (_, scripts, file) => {
    const renamed = manifestWith((contents) => {
      contents.lifecycle = "live";
      contents.dependencies = { "@sentry/bun": "10.24.0" };
      contents.scripts = { ...scripts, test: "bun test" };
    });
    const tree: Tree = {
      ...without(without(LIVE, BACKUP), RESTORE_DRILL),
      "package.json": renamed["package.json"] ?? "",
      ...(file === undefined ? {} : { [file]: "-- schema\n" }),
    };
    expect(await live(tree, { database: "none" })).toEqual([
      containing("must pass `database: postgres`"),
      containing("a live repo owns scripts/backup.sh"),
      containing("a live repo owns scripts/restore-drill.sh"),
    ]);
  });

  // ...and a live repo with no database anywhere in it still owes none of that.
  test("a repo with no schema and no migration script owes none of it", async () => {
    const none = manifestWith((contents) => {
      contents.lifecycle = "live";
      contents.dependencies = { "@sentry/astro": "10.24.0" };
      contents.scripts = { test: "bun test" };
    });
    const tree: Tree = {
      ...without(without(LIVE, BACKUP), RESTORE_DRILL),
      "package.json": none["package.json"] ?? "",
      ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n`,
    };
    expect(await live(tree, { database: "none" })).toEqual([]);
  });

  test("something in the repo has to report its crashes", async () => {
    const blind = manifestWith((contents) => {
      contents.lifecycle = "live";
    });
    expect(await live({ ...LIVE, "package.json": blind["package.json"] ?? "" })).toEqual([
      containing("a live repo reports its crashes"),
    ]);
  });

  // Sentry ships one SDK per runtime and the fact asserted is that something
  // reports its crashes — so a list of the ones we use today would fail the
  // first repo on a runtime nobody had thought of.
  test.each([
    "@sentry/bun",
    "@sentry/tanstackstart-react",
    "@sentry/react-native",
    "@sentry/astro",
  ])("%s satisfies it, from anywhere in the workspace", async (name) => {
    const blind = manifestWith((contents) => {
      contents.lifecycle = "live";
    });
    expect(
      await live({
        ...LIVE,
        "package.json": blind["package.json"] ?? "",
        "apps/api/package.json": JSON.stringify({ dependencies: { [name]: "10.24.0" } }),
      }),
    ).toEqual([]);
  });

  // Declaring is not shipping. A devDependency builds and tests the repo and
  // reaches no deployment, and a peer range states what a consumer may bring —
  // so an SDK in either is a repo whose crashes nobody hears.
  test.each(["devDependencies", "peerDependencies"] as const)(
    "a Sentry SDK in %s alone is not crash reporting",
    async (field) => {
      const declared = manifestWith((contents) => {
        contents.lifecycle = "live";
        contents[field] = { ...contents[field], "@sentry/bun": "10.24.0" };
      });
      expect(await live({ ...LIVE, "package.json": declared["package.json"] ?? "" })).toEqual([
        containing("a live repo reports its crashes"),
      ]);
    },
  );
});

// The rules are scoped to what the repo is. Half this fleet is a static site
// with a hostname and no database, and a gate that demanded a backup script of
// one would be teaching people to write a script that does nothing.
describe("a live repo with no database of its own", () => {
  test("owes crash reporting, and no database rituals", async () => {
    expect(await live(LIVE_STATIC, { database: "none" })).toEqual([]);
  });

  test("still owes the crash reporting", async () => {
    const blind = manifestWith((contents) => {
      contents.lifecycle = "live";
      delete contents.scripts?.["db:migrate"];
    });
    expect(
      await live(
        { ...LIVE_STATIC, "package.json": blind["package.json"] ?? "" },
        { database: "none" },
      ),
    ).toEqual([containing("a live repo reports its crashes")]);
  });

  // Owning a schema is read from the repo, so turning the CI job on does not
  // conjure one: the caller is told its input has no migration entry point
  // behind it, and the database rules stay off because there is still no
  // database.
  test("running the database job over a repo with no migrations is the caller's problem", async () => {
    expect(await live(LIVE_STATIC, { database: "postgres" })).toEqual([containing("db:migrate")]);
  });
});

// A monorepo keeps its migrations in the workspace that owns the schema, and
// the root's `db:migrate` is a passthrough to it. Asking only the root means
// two edits shed every database rule — drop the input, then delete a
// passthrough that now looks like dead weight — and the second one reads as a
// tidy-up.
describe("a live monorepo owns its database wherever the migrations live", () => {
  const inTheWorkspace: Tree = {
    ...without(
      without(
        manifestWith((contents) => {
          contents.lifecycle = "live";
          contents.dependencies = { "@sentry/bun": "10.24.0" };
          delete contents.scripts?.["db:migrate"];
        }),
        BACKUP,
      ),
      RESTORE_DRILL,
    ),
    "apps/api/package.json": JSON.stringify({
      name: "shop-api",
      scripts: { "db:migrate": "bun run src/db/migrate.ts" },
    }),
    ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n`,
  };

  test("so every rule holds, with the root carrying no script at all", async () => {
    expect(await live(inTheWorkspace, { database: "none" })).toEqual([
      containing("must pass `database: postgres`"),
      containing("must pass `upgrade-gate: true`"),
      // One finding per job, not three: a script that is not there is not a
      // script whose schedule anyone can say anything about.
      containing("a live repo owns scripts/backup.sh"),
      containing("a live repo owns scripts/restore-drill.sh"),
    ]);
  });
});

// The `database` input says which CI gates run, and it lives in the very file
// these rules are about. Keying off it would let a live repo drop its backup
// script, its rehearsed restore and its upgrade gate by deleting one line of
// its own workflow — so the contract asks the repo instead.
describe("a live repo cannot shed the database rules by editing its workflow", () => {
  test("owning migrations and running no database gate is its own problem", async () => {
    expect(await live(LIVE, { database: "none" })).toEqual([
      containing("must pass `database: postgres`"),
    ]);
  });

  test("and every rule it would have shed still holds", async () => {
    expect(await live(without(LIVE, BACKUP), { database: "none" })).toEqual([
      containing("must pass `database: postgres`"),
      containing("a live repo owns scripts/backup.sh"),
    ]);
  });
});

// The rule can be satisfied dishonestly, and that is what this waives. A repo
// whose box already dumps its database on a schedule — nfp-elysia's is a
// whole-server borg job under root's crontab with binlog shipping beside it —
// can only pass the rule as written by committing a SECOND backup of the same
// data on a SECOND schedule, reviewed and enabled separately. Two answers to
// "when is this dumped" is the failure the rule exists to prevent, reached from
// the other side (dev-config#65's sibling, nfp-elysia#160).
describe("a live repo whose data jobs run outside it", () => {
  /** LIVE with neither script and neither unit pair: the repo that owns nothing here. */
  const NO_SCRIPTS: Tree = without(
    without(without(without(LIVE, BACKUP), RESTORE_DRILL), `scripts/${UNITS}backup.timer`),
    `scripts/${UNITS}backup.service`,
  );
  const NOTHING_COMMITTED: Tree = without(
    without(NO_SCRIPTS, `scripts/${UNITS}restore-drill.timer`),
    `scripts/${UNITS}restore-drill.service`,
  );

  const RUNBOOK =
    "the box's borg job at 02:05 from root's crontab, restore drill in /var/backups/db_dumps/PITR-RUNBOOK.md";

  test("passes once it says where they run", async () => {
    expect(await live(NOTHING_COMMITTED, { dataJobsExternal: RUNBOOK })).toEqual([]);
  });

  // The reason IS the waiver, so there is no spelling that claims it without
  // naming the jobs: an empty value, and a value made of whitespace, are both
  // "this repo owns them" and get the whole rule back. The wrong implementation
  // is the switch-plus-optional-reason, which passes the second of these.
  test.each([
    ["empty", ""],
    ["whitespace", "   \n  "],
  ])("and a %s reason waives nothing", async (_what, reason) => {
    expect(await live(NOTHING_COMMITTED, { dataJobsExternal: reason })).toEqual([
      containing("a live repo owns scripts/backup.sh"),
      containing("a live repo owns scripts/restore-drill.sh"),
    ]);
  });

  // The diagnostic has to name the way out, because a repo whose backups
  // genuinely run elsewhere cannot guess that the answer is an input at the
  // call site — it reads the rule as one it must satisfy by writing a script.
  test("and the refusal names the input that is the way out", async () => {
    expect(await live(NOTHING_COMMITTED)).toEqual([
      containing("name it in `data-jobs-external` at the call site"),
      containing("name it in `data-jobs-external` at the call site"),
    ]);
  });

  // Still waiving something, the way `lifecycle-retire` has to be. A repo that
  // claims external jobs and commits one anyway has exactly the duplicate the
  // waiver was granted to avoid, and neither copy is the one somebody reads.
  test.each([BACKUP, RESTORE_DRILL])(
    "but %s committed beside it is the duplicate",
    async (path) => {
      const both: Tree = { ...NOTHING_COMMITTED, [path]: "#!/usr/bin/env bash\n" };
      expect(await live(both, { dataJobsExternal: RUNBOOK })).toEqual([
        containing(`${path} is one of them committed here anyway`),
      ]);
    },
  );

  // It waives the data jobs and nothing else: the crash reporting a live repo
  // owes is a product decision per repo, not an infrastructure duplicate.
  test("and it does not waive the crash reporting", async () => {
    const blind = manifestWith((contents) => {
      contents.lifecycle = "live";
    });
    expect(
      await live(
        { ...NOTHING_COMMITTED, "package.json": blind["package.json"] ?? "" },
        { dataJobsExternal: RUNBOOK },
      ),
    ).toEqual([containing("a live repo reports its crashes")]);
  });
});

// The other half of the same rule. `database` says which gates run, not whether
// this workflow's Postgres job is one of them: a workflow wrapping check.yml
// replaces that job with its own dialect's and calls this one with `external`,
// and a live consumer of it was refused for a job somebody had deliberately
// taken over — the schema it owns is replayed, by a gate this one cannot see.
describe("a wrapper workflow's database gates satisfy the rule this job's would", () => {
  /** LIVE's call with the upgrade gate taken off, which is what `external` may not ask for. */
  const CALLS_EXTERNAL: Tree = {
    ...LIVE,
    ".github/workflows/ci.yml": (LIVE[".github/workflows/ci.yml"] ?? "").replace(
      "      database: postgres\n      upgrade-gate: true\n",
      "      database: external\n",
    ),
  };

  test("a live repo that owns migrations passes on external", async () => {
    expect(await live(CALLS_EXTERNAL, { database: "external" })).toEqual([]);
  });

  // The upgrade gate goes with the job. check.yml REFUSES `upgrade-gate: true`
  // without `database: postgres`, so a contract demanding it here would be
  // demanding the one configuration the shared workflow rejects — the argument
  // that already scopes this rule to a repo with a database, one case wider.
  // The wrapper that took the job over is what owes its consumers the gate.
  test("and is not asked for an upgrade gate this call cannot carry", async () => {
    expect(
      await live(CALLS_EXTERNAL, { database: "external" }).then((problems) =>
        problems.filter((message) => message.includes("upgrade-gate")),
      ),
    ).toEqual([]);
  });

  // The shape the wrapper's own consumers are in: CI is a call into the
  // wrapper, so `ci-call` waives the call-by-path fact, and `external` is what
  // that wrapper passes down. This is the tree gokayo43/dev-config#65 was filed
  // about, and the rule it was refused on.
  test("a consumer whose CI calls the wrapper is not refused for the job it replaced", async () => {
    const throughTheWrapper: Tree = {
      ...LIVE,
      ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config-db/.github/workflows/check.yml@${PIN}\n    with:\n      database: true\n`,
    };
    expect(
      await live(throughTheWrapper, { database: "external", exemptions: ["ci-call"] }),
    ).toEqual([]);
    expect(await live(throughTheWrapper, { database: "none", exemptions: ["ci-call"] })).toEqual([
      containing("must pass `database: postgres`"),
    ]);
  });
});

// The exemption says CI is not a call into check.yml. There is then no call to
// pass `upgrade-gate: true` to, and the docs say so — this is that sentence,
// executed.
describe("ci-call waives the upgrade-gate rule with the call it is about", () => {
  test("a live repo whose CI is its own is not asked about a call it does not make", async () => {
    const own = {
      ...LIVE,
      ".github/workflows/ci.yml":
        "name: CI\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo green\n",
    };
    expect(await live(own, { exemptions: ["ci-call"] })).toEqual([]);
    expect(await live(own)).toEqual([containing("check.yml")]);
  });
});

/**
 * The live site with that one word moved and nothing else. A tree with no
 * database of its own is the smallest thing "live" can be, so every case below
 * differs from its neighbour by the field and never by a backup script.
 */
function declaring(value: string | undefined): Tree {
  const manifest = liveManifest((contents) => {
    if (value === undefined) delete contents.lifecycle;
    else contents.lifecycle = value;
  });
  return { ...LIVE_STATIC, "package.json": manifest["package.json"] ?? "" };
}

/** What a push of this branch tells the gate: the tip it had before. */
function pushedOver(rev: string | undefined): Event {
  return { baseRef: "", before: rev ?? "" };
}

/** The gate against a repository with history, and against the project rather than the checkout. */
async function graded(root: string, overrides: Partial<Contract> = {}): Promise<string[]> {
  const asked: Contract = { ...DEFAULTS, database: "none", ...overrides };
  return (await repoContract(root, asked)).map(({ message }) => message);
}

// The field only ever moves up. `dev` says nothing about anyone and everything
// is reachable from it; `live` says people are on the other end, and that does
// not stop being true because a line was tidied out of a manifest. So the tree
// in front of the gate is not the only witness — the base ref is read too, and
// these are real repositories with real commits because that is the whole
// mechanism under test.
describe("the lifecycle field only moves up", () => {
  test("dev to live is the commit the field exists for", async () => {
    const repo = await history(declaring("dev"), declaring("live"));
    expect(await graded(repo.root, { event: pushedOver(repo.revs[0]) })).toEqual([]);
  });

  test("a first commit has nothing to be held to", async () => {
    const repo = await history(declaring("dev"));
    expect(await graded(repo.root, { event: pushedOver(undefined) })).toEqual([]);
  });

  test("live to live is every other commit a live repo makes", async () => {
    const repo = await history(declaring("live"), declaring("live"));
    expect(await graded(repo.root, { event: pushedOver(repo.revs[0]) })).toEqual([]);
  });

  test("live to dev is refused, and says which commit said live", async () => {
    const repo = await history(declaring("live"), declaring("dev"));
    const problems = await graded(repo.root, { event: pushedOver(repo.revs[0]) });

    expect(problems).toEqual([
      containing(`lifecycle was "live" at ${(repo.revs[0] ?? "").slice(0, 7)}`),
    ]);
    expect(problems[0]).toContain('now reads "dev"');
    expect(problems[0]).toContain("lifecycle-retire");
  });

  // Deleting the field is the same act as writing `dev` over it, and it is the
  // one a reviewer is least likely to notice — so it gets the diagnostic about
  // what was lost rather than the one about a repo that never said.
  test("live to absent is refused as the deletion it is, not as a repo that never declared", async () => {
    const repo = await history(declaring("live"), declaring(undefined));
    const problems = await graded(repo.root, { event: pushedOver(repo.revs[0]) });

    expect(problems).toEqual([containing('lifecycle was "live" at')]);
    expect(problems[0]).toContain("and now is absent");
  });

  // Deleting the manifest outright is already the end of the contract: there is
  // nothing left to read a field out of, and the gate says so first.
  test("live to no manifest at all is refused by the contract it takes with it", async () => {
    const repo = await history(declaring("live"), without(declaring("live"), "package.json"));
    expect(await graded(repo.root, { event: pushedOver(repo.revs[0]) })).toEqual([
      containing("the repo has no package.json"),
    ]);
  });

  // The far side of the comparison is arbitrary historical content. A commit
  // whose manifest will not parse declared nothing readable — and this gate
  // refuses that commit on its own terms — so it is an answer here rather than
  // a crash inside a check about a different field entirely.
  test("a base commit whose manifest will not parse declared nothing", async () => {
    const repo = await history({ ...declaring("dev"), "package.json": "{ oops" }, declaring("dev"));
    expect(await graded(repo.root, { event: pushedOver(repo.revs[0]) })).toEqual([]);
  });

  test("a pull request is held to it too, from the merge base", async () => {
    const repo = await history(declaring("live"), declaring("dev"));
    await git(repo.root, ["update-ref", "refs/remotes/origin/main", repo.revs[0] ?? ""]);

    expect(await graded(repo.root, { event: { baseRef: "main", before: "" } })).toEqual([
      containing('lifecycle was "live" at'),
    ]);
  });
});

// A monorepo's project is not at the repository root, and the base ref is read
// relative to the project rather than to the checkout — otherwise every
// workspace would be graded against whatever the root manifest happened to say.
describe("the base ref is read where the project is", () => {
  const PROJECT = "apps/api";

  test("so a workspace that went back to dev is caught inside the monorepo", async () => {
    const repo = await history(under(PROJECT, declaring("live")), under(PROJECT, declaring("dev")));
    expect(await graded(join(repo.root, PROJECT), { event: pushedOver(repo.revs[0]) })).toEqual([
      containing('lifecycle was "live" at'),
    ]);
  });

  // The other cell, and the one that proves the read above is a real read: a
  // project this branch adds has no manifest at the base ref, so there is no
  // earlier declaration to hold it to.
  test("and a workspace this branch adds has nothing to be held to", async () => {
    const repo = await history(under("apps/web", { "index.ts": "export {};\n" }), {
      ...under("apps/web", { "index.ts": "export {};\n" }),
      ...under(PROJECT, declaring("dev")),
    });
    expect(await graded(join(repo.root, PROJECT), { event: pushedOver(repo.revs[0]) })).toEqual([]);
  });
});

// A repo really is wound down sometimes, and that is a decision rather than a
// diff. The exemption is where it gets written down — and it waives the
// comparison with the base ref, nothing else.
describe("lifecycle-retire", () => {
  test("lets a retired repo say dev again", async () => {
    const repo = await history(declaring("live"), declaring("dev"));
    const event = pushedOver(repo.revs[0]);

    expect(await graded(repo.root, { event })).toEqual([containing('lifecycle was "live" at')]);
    expect(await graded(repo.root, { event, exemptions: ["lifecycle-retire"] })).toEqual([]);
  });

  // Retiring is moving the field down, not deleting it: a repo still has to say
  // which of the two it is, and that rule is nobody's to waive here.
  test("does not waive having to declare one at all", async () => {
    const repo = await history(declaring("live"), declaring(undefined));
    expect(
      await graded(repo.root, {
        event: pushedOver(repo.revs[0]),
        exemptions: ["lifecycle-retire"],
      }),
    ).toEqual([containing("lifecycle is absent")]);
  });
});

// A base branch this run names and this checkout does not carry is a broken
// run, not a repo that has nothing to be compared against — so it is refused
// whoever is asking, `dev` repos included. Reading it as "no base ref" is the
// hole the shallow case would be, with the history sitting right there.
describe("a base ref the checkout does not carry", () => {
  async function withoutTheRef(value: string): Promise<string> {
    const repo = await history(declaring("live"), declaring(value));
    // Not shallow: the whole history is here. Only the ref is not.
    expect((await git(repo.root, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("false");
    return repo.root;
  }

  const asked = { event: { baseRef: "main", before: "" } };

  test("is refused even though the tree reads dev", async () => {
    expect(await graded(await withoutTheRef("dev"), asked)).toEqual([
      containing("refs/remotes/origin/main is not in this checkout"),
    ]);
  });

  test("and refused for a live tree the same way", async () => {
    expect(await graded(await withoutTheRef("live"), asked)).toEqual([
      containing("refs/remotes/origin/main is not in this checkout"),
    ]);
  });

  // Retiring excuses a lifecycle that moved down. It says nothing about whether
  // this run was pointed at a branch that exists — so it neither waives this
  // nor gets named by it: the same run refuses identically without it, and a
  // diagnostic that blamed the exemption would point at the wrong subject.
  test("and lifecycle-retire neither excuses it nor is blamed for it", async () => {
    const withExemption = await graded(await withoutTheRef("dev"), {
      ...asked,
      exemptions: ["lifecycle-retire"],
    });

    expect(withExemption).toEqual([containing("refs/remotes/origin/main is not in this checkout")]);
    expect(withExemption[0]).not.toContain("lifecycle-retire");
  });
});

// Every other exemption states something permanent about what a repo is. This
// one states that a repo is mid-retirement, which stops being true — so left
// behind it is a standing licence to move the field back down, granted once and
// never looked at again.
describe("a lifecycle-retire that is waiving nothing", () => {
  const retiring = { exemptions: ["lifecycle-retire"] };

  test("is refused once the retirement has landed", async () => {
    const repo = await history(declaring("dev"), declaring("dev"));
    const problems = await graded(repo.root, { ...retiring, event: pushedOver(repo.revs[0]) });

    expect(problems).toEqual([containing("lifecycle-retire is waiving nothing")]);
    expect(problems[0]).toContain("the base ref does not declare this repo live");
  });

  test("is refused on a repo that never came down at all", async () => {
    const repo = await history(declaring("live"), declaring("live"));
    const problems = await graded(repo.root, { ...retiring, event: pushedOver(repo.revs[0]) });

    expect(problems).toEqual([containing("lifecycle-retire is waiving nothing")]);
    expect(problems[0]).toContain('this tree both read "live"');
  });

  // The rule above is only as good as its weakest checkout. An exemption nobody
  // can check would be a standing waiver again, one `fetch-depth: 1` away — so
  // naming it is what obliges the run to be able to show it is doing something.
  test("is refused when the checkout cannot show it is waiving anything", async () => {
    const repo = await history(declaring("live"), declaring("live"));
    const shallow = join(repo.root, "shallow");
    await git(repo.root, ["clone", "--quiet", "--depth", "1", `file://${repo.root}`, shallow]);

    expect(await graded(shallow, retiring)).toEqual([
      containing("lifecycle-retire cannot be checked here"),
    ]);
  });
});

// A checkout with no history reads as a repo whose base ref never said `live`.
// It is refused while the repo is still live — the commit before the one that
// would violate the rule — which raises the cost of moving the field down to a
// visible change of the workflow's checkout depth. Not to impossible: see
// docs/gates/repo-contract.md for the residual a `ci-call` repo keeps.
describe("a checkout that cannot answer", () => {
  async function shallowClone(value: string): Promise<string> {
    const repo = await history(declaring(value), declaring(value));
    const shallow = join(repo.root, "shallow");
    await git(repo.root, ["clone", "--quiet", "--depth", "1", `file://${repo.root}`, shallow]);
    return shallow;
  }

  test("is refused while the repo is live", async () => {
    expect(await graded(await shallowClone("live"))).toEqual([
      containing("the checkout is shallow"),
    ]);
  });

  // A dev repo never needed history for this, and would otherwise start failing
  // on the shallow checkouts it has always been gated on.
  test("costs a dev repo nothing", async () => {
    expect(await graded(await shallowClone("dev"))).toEqual([]);
  });
});
