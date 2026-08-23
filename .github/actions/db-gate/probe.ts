import { plainly, type Problem, type Verdict } from "../_lib/gate.ts";

/**
 * The repo's own black-box probe of the app the boot step brought up: a real
 * process making real requests, against a database this job's migrations built
 * and an app that has already answered its health route. Nothing here is
 * stubbed, and nothing here knows what the probe is asserting.
 *
 * It sits between the boot and the ramp because the two floors either side of
 * it cannot ask this question. Health answering 200 proves the app *starts*
 * against that schema; the ramp's route floor proves every route was *reached*.
 * Neither says a single answer was correct — so a migration that applies, boots
 * and serves every route while quietly reinterpreting what a column means
 * passes both. What the probe asserts is the repo's, because only the repo
 * knows what its answers are supposed to be.
 *
 * That makes the contract the smallest one that can carry a claim this gate
 * cannot read: **stdout is the verdict.** Every line the command writes there
 * is one problem, whatever it exits with, and a command that exits non-zero
 * having written nothing is a failure the gate has to word for itself.
 *
 * Stdout rather than the exit status, because the status is the half a probe
 * gets wrong. A runner that collects failures and reports them at the end, a
 * shell function whose last command happened to succeed, a `set +e` somebody
 * added while debugging: each of those prints exactly what is broken and then
 * exits 0. Reading the status first would make this gate's answer depend on the
 * one thing about a repo's own program it cannot see, and the failure mode is
 * silence over an app that said out loud what was wrong with it.
 *
 * `capacity-script` hands a repo the same authorship one step later, and for
 * the same reason — the gate owns the running, the repo owns the meaning.
 */

/** The one variable the probe is given, spelled as the boot step and the ramp both spell it. */
export const APP_URL = "HEALTH_URL";

export interface Probe {
  /** Where the command runs — the project the caller declared. */
  readonly root: string;
  /** The probe, as shell: the way a repo names a command it has not put in a package script. */
  readonly command: string;
  /** The booted app, handed over under the name every other step here uses for it. */
  readonly url: string;
  /** How long the command gets before it is killed. */
  readonly seconds: number;
}

/**
 * How long a probe gets when the caller names no bound of its own — the one
 * place the number is written, which is what lets `probe-timeout` default to
 * "unset" in two YAML files rather than to a literal each of them could drift.
 *
 * Two minutes, against a command that runs *after* the app is up: it is making
 * a handful of contract requests against a local process, not waiting for a
 * boot, so this is far more than any honest probe needs. It is a bound at all
 * for the reason the mutation lane's ten minutes is one — a probe that has
 * wedged is otherwise indistinguishable from a slow one, and it would spend the
 * job's whole fifteen minutes saying so, taking the ramp and every piece of
 * evidence after it down with it.
 */
export const DEFAULT_SECONDS = 120;

/**
 * The bound as the input spells it. A spelling this does not know is refused
 * rather than defaulted, for the reason `upgrade-gate`'s two words are: it
 * would otherwise become a number nobody chose, and a probe killed under a
 * bound its author never wrote is a failure nobody can reason about. Zero is
 * refused with the rest — it is a bound no command can be inside of. Empty is
 * the caller who named none, which is the one reading that is not a mistake.
 */
const WHOLE = /^\d+$/u;

/**
 * The largest bound this will take, and the reason it has one at all is
 * arithmetic rather than policy: `setTimeout` holds its delay in a signed
 * 32-bit integer, so any bound at or above 2147484 seconds overflows to 1ms and
 * the probe is killed the instant it starts. A caller who wrote a very large
 * number to mean "effectively no bound" would get the tightest bound there is,
 * and a diagnostic saying their probe ran too long.
 *
 * An hour, rather than the overflow point: the whole database job is bounded at
 * fifteen minutes by `check.yml`, so every value between the two is already
 * unreachable, and refusing at a number a person can reason about beats
 * refusing at one that only makes sense if you know how a timer is stored.
 */
const LONGEST_SECONDS = 3600;

export function secondsFrom(value: string): number {
  if (value === "") return DEFAULT_SECONDS;
  const seconds = WHOLE.test(value) ? Number(value) : 0;
  if (seconds <= 0) {
    throw new Error(
      `probe-timeout is "${value}" — it takes a whole number of seconds greater than zero, and nothing else can be read as one`,
    );
  }
  if (seconds > LONGEST_SECONDS) {
    throw new Error(
      `probe-timeout is ${seconds}s, which is longer than the ${LONGEST_SECONDS}s this takes — the database job it runs in is bounded well below that, and a bound large enough to overflow the timer it is stored in kills the probe immediately instead of never`,
    );
  }
  return seconds;
}

/**
 * The escape sequences a coloured program writes around its own output. The
 * environment already asks every child here not to colour — see `plainly` — but
 * a probe that colours unconditionally, or one that wraps a tool which does,
 * writes them anyway, and they would arrive inside the annotation as the
 * literal bytes `ESC[31m`. Stripped where the line becomes a problem rather
 * than where it is read, so the log keeps what the command actually wrote.
 */
// oxlint-disable-next-line no-control-regex -- the escape character is the subject: this matches CSI and OSC sequences by the bytes they are
const ANSI = /\u001B(?:\[[\d;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/gu;

/**
 * The app's URL, refused rather than passed on when there is none.
 *
 * `health-url` is required by the action and defaulted by the workflow, so
 * empty means a caller wrote an empty string — and the probe would then be run
 * against `HEALTH_URL=""`, which every reasonable probe reads as "no app" and
 * some read as the current directory. A gate that ran the repo's assertions
 * against nothing and reported them as findings is worse than one that stops.
 */
export function appUrlFrom(value: string): string {
  if (value === "") {
    throw new Error(
      `health-url is empty — the probe is handed it as ${APP_URL}, and a probe pointed at no app cannot assert anything about one`,
    );
  }
  return value;
}

/**
 * The lines a command meant as separate statements. Trimmed and emptied out,
 * because a command that ends its output with a newline — which every command
 * that uses `echo` does — is not making a final claim about nothing.
 */
function saidIn(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.replaceAll(ANSI, "").trim())
    .filter((line) => line !== "");
}

/**
 * How many of those lines become annotations. A probe is one or two
 * contract-level assertions per invariant, so an honest one is nowhere near
 * this; a probe that dumps a log or a stack trace is, and four thousand
 * annotations render as neither a list nor a page. The whole output is on the
 * log above them either way, which is where a reader goes for the rest.
 */
const MOST_PROBLEMS = 50;

function capped(said: readonly Problem[]): Problem[] {
  if (said.length <= MOST_PROBLEMS) return [...said];
  const rest = said.length - MOST_PROBLEMS;
  return [
    ...said.slice(0, MOST_PROBLEMS),
    {
      message: `probe-command wrote ${said.length} lines to stdout and the first ${MOST_PROBLEMS} are above — the other ${rest} are on the log with them. A probe names one broken invariant per line; this many is a program reporting something else, and the annotations are not where to read it.`,
    },
  ];
}

/** The two answers a race here can give that are not the command's own output. */
const OVERRAN = Symbol("the bound fired");
const TOO_LATE = Symbol("the output did not arrive before the grace ran out");

/** How long the output gets to arrive once the group has been killed. */
const SALVAGE_MS = 5_000;

function after(ms: number): Promise<typeof TOO_LATE> {
  return new Promise((resolve) => {
    // Unref'd, so that a grace nobody is waiting on any more cannot be the
    // thing keeping this process alive after the race has been won.
    setTimeout(() => resolve(TOO_LATE), ms).unref();
  });
}

/**
 * Everything the probe started, by the process group `setsid` gave it.
 *
 * The refusal is named rather than guarded away: the group is already gone
 * whenever the command exited between losing the race above and this line, and
 * ESRCH is that and nothing else. Whatever is left to say about the run is the
 * annotation this is on the way to writing.
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group finished on its own between the race and here.
  }
}

export async function probeGate({ root, command, url, seconds }: Probe): Promise<Verdict> {
  // Half of a pair is a caller who asked for something and would not get it —
  // the same refusal `backfillGate` makes, and the reason this step runs when
  // *either* input is set rather than only when the command is. A bound with
  // no command under it bounds nothing, and being quietly ignored is how an
  // input somebody wrote turns out never to have been read.
  if (command === "") {
    return {
      problems: [
        {
          message: `probe-timeout is set to ${seconds}s and probe-command is empty — the bound is on that command, and there is no probe here for it to bound`,
        },
      ],
    };
  }

  // A controller of this function's own rather than the `timeout` option, so
  // that "the bound fired" is something it can *read* — nothing else aborts
  // this signal. Inferring it from the exit instead would be wrong about the
  // one case worth being right about: a probe the OOM killer took also dies on
  // SIGKILL, and telling its author it ran too long sends them to tune a bound
  // that was never the problem.
  const stopping = new AbortController();
  const bound = setTimeout(() => stopping.abort(), seconds * 1000);
  const overran = new Promise<typeof OVERRAN>((resolve) => {
    stopping.signal.addEventListener("abort", () => resolve(OVERRAN), { once: true });
  });

  let out = "";
  let err = "";
  let status = 0;
  let killed = false;
  try {
    // `setsid` first, and it is the whole of what makes the bound real.
    //
    // The command is shell for the reason the boot step's is — a pipe, an `&&`
    // or a quoted argument is shell, and a split on whitespace would run
    // something the caller did not write. But bash only *execs* a command that
    // is one simple command; a pipeline, a subshell or a background job is a
    // fork, and killing the bash that spawned it leaves the children running.
    // Those children still hold the write end of the stdout pipe, so the read
    // below never sees EOF: `probeGate` would not return at all, and a bound
    // that hangs is worse than no bound, because the job's whole timeout goes
    // with nothing said.
    //
    // Under `setsid` the shell is a process-group leader, so the kill below
    // addresses the group and takes everything the probe started. A probe whose
    // own children were meant to outlive it — nothing here has one — would be
    // taken too, which is the trade a bound is.
    const proc = Bun.spawn(["setsid", "bash", "-c", command], {
      cwd: root,
      env: { ...plainly(process.env), [APP_URL]: url },
      // Piped rather than inherited, because stdout is the protocol here: the
      // step reads it back as the problems the repo is reporting.
      stdout: "pipe",
      stderr: "pipe",
      // No `signal:` — Bun would kill the process it spawned, which is the one
      // process this cannot settle for. The group kill below is the point.
    });

    const collected = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Raced rather than awaited, so that the bound bounds *this function* and
    // not merely the shell: whatever is still holding the pipe, the overrun is
    // what the step goes on.
    const finished = await Promise.race([collected, overran]);
    if (finished === OVERRAN) {
      killed = true;
      killGroup(proc.pid);
      // Bounded again, and for the reason the first bound exists: the group
      // kill closes the pipes for everything the probe started, so this settles
      // at once — and a survivor that escaped the group by making a session of
      // its own must not turn a report into a hang a second time. What the
      // grace does not collect is lost, which the annotation says.
      const salvaged = await Promise.race([collected, after(SALVAGE_MS)]);
      if (salvaged !== TOO_LATE) [out, err] = salvaged;
    } else {
      [out, err, status] = finished;
    }
  } finally {
    // Or a probe that finished in a second holds the process open for the rest
    // of its bound, with the step waiting on a timer nothing is left to fire.
    clearTimeout(bound);
  }

  if (killed) {
    return {
      note: "probe: the command did not finish",
      log: `${out}${err}`.trimEnd(),
      problems: [
        {
          message: `probe-command (\`${command}\`) was still running after ${seconds}s and was killed, along with everything it had started — whatever it writes after that is lost, so nothing it was asserting was graded; make the probe answer inside the bound, or raise probe-timeout and say why the app needs that long`,
        },
      ],
    };
  }

  const log = `${out}${err}`.trimEnd();

  // Read before the status, and independently of it: a probe that names two
  // broken invariants and then exits 0 has still named them.
  const said: Problem[] = capped(saidIn(out).map((line) => ({ message: line })));

  // A command that fails and says nothing is still a failure, and a red step
  // with an empty explanation is the one thing no gate here may produce. The
  // annotation then says what the repo's own contract was and what to write.
  if (said.length === 0 && status !== 0) {
    said.push({
      message: `probe-command (\`${command}\`) exited ${status} and wrote nothing to stdout — a failing probe names each invariant it broke on a line of its own, since the gate running it cannot know what it was asserting`,
    });
  }

  if (said.length === 0) {
    return {
      note: `probe: \`${command}\` came back clean against the booted app`,
      log,
      problems: [],
    };
  }

  return {
    // Counted off what is annotated rather than off what the command wrote, so
    // that the line above the annotations and the annotations themselves cannot
    // say different things about the same run.
    note: `probe: \`${command}\` reported ${said.length} problem${said.length === 1 ? "" : "s"}`,
    log,
    problems: said,
  };
}
