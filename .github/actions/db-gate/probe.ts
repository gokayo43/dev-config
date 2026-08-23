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

export function secondsFrom(value: string): number {
  if (value === "") return DEFAULT_SECONDS;
  const seconds = WHOLE.test(value) ? Number(value) : 0;
  if (seconds <= 0) {
    throw new Error(
      `probe-timeout is "${value}" — it takes a whole number of seconds greater than zero, and nothing else can be read as one`,
    );
  }
  return seconds;
}

/**
 * The lines a command meant as separate statements. Trimmed and emptied out,
 * because a command that ends its output with a newline — which every command
 * that uses `echo` does — is not making a final claim about nothing.
 */
function saidIn(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
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

  let out = "";
  let err = "";
  let status = 0;
  try {
    // Through bash for the reason the boot step runs `start-command` that way:
    // a pipe, a `&&` or a quoted argument is shell, and a split on whitespace
    // would run something the caller did not write.
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: root,
      env: { ...plainly(process.env), [APP_URL]: url },
      // Piped rather than inherited, because stdout is the protocol here: the
      // step reads it back as the problems the repo is reporting.
      stdout: "pipe",
      stderr: "pipe",
      signal: stopping.signal,
      killSignal: "SIGKILL",
    });
    [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    status = await proc.exited;
  } finally {
    // Or a probe that finished in a second holds the process open for the rest
    // of its bound, with the step waiting on a timer nothing is left to fire.
    clearTimeout(bound);
  }

  if (stopping.signal.aborted) {
    return {
      note: "probe: the command did not finish",
      log: `${out}${err}`.trimEnd(),
      problems: [
        {
          message: `probe-command (\`${command}\`) was still running after ${seconds}s and was killed — whatever it writes after that is lost, so nothing it was asserting was graded; make the probe answer inside the bound, or raise probe-timeout and say why the app needs that long`,
        },
      ],
    };
  }

  const log = `${out}${err}`.trimEnd();

  // Read before the status, and independently of it: a probe that names two
  // broken invariants and then exits 0 has still named them.
  const said: Problem[] = saidIn(out).map((line) => ({ message: line }));

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
