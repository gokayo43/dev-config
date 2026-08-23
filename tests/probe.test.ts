import { describe, expect, test } from "bun:test";

import { publish, type Verdict } from "../.github/actions/_lib/gate.ts";
import {
  APP_URL,
  appUrlFrom,
  DEFAULT_SECONDS,
  probeGate,
  secondsFrom,
} from "../.github/actions/db-gate/probe.ts";

import { containing } from "./matchers.ts";
import { materialise } from "./tree.ts";

/**
 * What `publish` writes to stdout for a verdict, which is the step's whole
 * observable output: GitHub reads those lines as commands. Captured rather than
 * inspected field by field, so a case can assert what a reader sees instead of
 * how the verdict happened to spell it.
 */
async function published(verdict: Verdict): Promise<string[]> {
  const lines: string[] = [];
  // oxlint-disable-next-line no-console -- stdout is the protocol under test, and capturing it is the only way to read what the step publishes
  const wrote = console.log;
  // oxlint-disable-next-line no-console -- the same
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await publish(verdict);
  } finally {
    // oxlint-disable-next-line no-console -- the same
    console.log = wrote;
  }
  return lines;
}

/**
 * Real processes, because the whole of what this gate does is run one and read
 * what it wrote. A fake in place of the spawn would be a suite agreeing with
 * itself about exit statuses, and the three facts that actually decide a verdict
 * — the status, the stdout, and whether the bound fired — are the three a fake
 * would be inventing.
 *
 * No database and no app: the probe's subject is the repo's own command, and
 * what it is pointed at is a URL handed to it in an environment variable. A
 * booted app would be a second thing to keep alive per case and would not
 * change a single branch here.
 */
const URL_OF_THE_APP = "http://localhost:3000/api/health";

async function ran(command: string, seconds = DEFAULT_SECONDS, root = "."): Promise<Verdict> {
  return await probeGate({ root, command, url: URL_OF_THE_APP, seconds });
}

function messages({ problems }: Verdict): string[] {
  return problems.map(({ message }) => message);
}

describe("the post-boot probe", () => {
  test("a command that exits 0 and says nothing is a pass", async () => {
    const verdict = await ran("true");

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toContain("came back clean against the booted app");
  });

  // What the step actually writes, rather than which field the verdict happens
  // to carry it in: a probe that wrote nothing must publish its notice and not
  // a bare `::notice::` or an empty line standing for output nobody produced.
  test("a silent pass publishes its notice and nothing else", async () => {
    expect(await published(await ran("true"))).toEqual([containing("::notice::probe:")]);
  });

  // The contract's whole point, and the case the exit status hides. A probe
  // runner that collects failures and reports them at the end, or a `set +e`
  // somebody added while debugging, prints exactly what is broken and exits 0 —
  // and the wrong implementation reads the status first and calls it clean.
  test("a command that names violations and then exits 0 has still named them", async () => {
    const verdict = await ran(
      `printf '%s\n' 'GET /presets/1 answered 500' 'POST /presets accepted a dup'; exit 0`,
    );

    expect(messages(verdict)).toEqual([
      "GET /presets/1 answered 500",
      "POST /presets accepted a dup",
    ]);
    expect(verdict.note).toContain("reported 2 problems");
    expect(verdict.note).not.toContain("came back clean");
  });

  // The contract the whole hook rests on: the repo owns the meaning, so each
  // line it writes is one problem. The wrong implementation this kills is the
  // obvious one — a single problem carrying the whole output — which reads as
  // one broken invariant however many the probe found, and buries every line
  // after the first inside one annotation.
  test("each line a failing command writes to stdout is one problem", async () => {
    const verdict = await ran(
      `printf '%s\\n' 'GET /presets/1 answered 500' 'POST /presets accepted a slug that exists'; exit 1`,
    );

    expect(messages(verdict)).toEqual([
      "GET /presets/1 answered 500",
      "POST /presets accepted a slug that exists",
    ]);
    expect(verdict.note).toContain("reported 2 problems");
  });

  test("one broken invariant is one problem, and the note counts it as one", async () => {
    const verdict = await ran(`echo 'the preset slug is no longer unique'; exit 3`);

    expect(messages(verdict)).toEqual(["the preset slug is no longer unique"]);
    expect(verdict.note).toContain("reported 1 problem");
    expect(verdict.note).not.toContain("1 problems");
  });

  // A trailing newline is what `echo` writes, not a final claim about nothing —
  // and an implementation that split without filtering would annotate an empty
  // line for every probe that ever ran.
  test("the newline a command ends on is not a problem of its own", async () => {
    const verdict = await ran(`printf 'one thing\\n\\n  \\n'; exit 1`);

    expect(messages(verdict)).toEqual(["one thing"]);
  });

  // The one thing no gate here may produce. A probe that dies before it can say
  // anything — a missing binary, a syntax error in the shell it was written in —
  // is still a failure, and a red step with an empty explanation leaves its
  // author with nothing but an exit status.
  test("a command that fails and says nothing still says what the contract was", async () => {
    const verdict = await ran("exit 7");

    expect(messages(verdict)).toEqual([containing("exited 7 and wrote nothing to stdout")]);
    expect(messages(verdict)[0]).toContain("names each invariant it broke on a line of its own");
    // The line above the annotations and the annotations themselves must not
    // say different things about one run: counting what the command wrote
    // rather than what is being reported makes this note read "0 problems"
    // over an annotation that is plainly a problem.
    expect(verdict.note).toContain("reported 1 problem");
  });

  test("everything the command wrote reaches the log, stderr included", async () => {
    const verdict = await ran(`echo out; echo err >&2; exit 1`);

    expect(verdict.log).toContain("out");
    expect(verdict.log).toContain("err");
  });

  // The bound exists so that a probe which has wedged cannot spend the job's
  // whole budget. The wrong implementation is the one with no bound at all,
  // which passes every other case here and hangs on this one.
  test("a command that never finishes is killed, and the annotation names the bound", async () => {
    const verdict = await ran("sleep 30", 1);

    expect(messages(verdict)).toEqual([containing("was still running after 1s and was killed")]);
    expect(messages(verdict)[0]).toContain("raise probe-timeout");
    expect(verdict.note).toContain("did not finish");
  }, 15_000);

  /**
   * The four shapes that defeated the bound, and the reason the shell is run
   * under `setsid`.
   *
   * bash *execs* a single simple command, so killing the process bun spawned
   * took the `sleep 30` above with it and every bound looked like it worked. A
   * pipeline, a subshell, a background job and a command that forks a child of
   * its own are not exec'd — the children survive the shell, keep the write end
   * of the stdout pipe open, and the read of that pipe never sees EOF. The
   * wrong implementation does not fail these cases: it **hangs** in them, which
   * is why each carries a bound well under what the unfixed code took.
   */
  test.each([
    ["a pipeline", "sleep 30 | cat"],
    ["a subshell", "( sleep 30 )"],
    ["a background job", "sleep 30 & wait"],
    ["a command that forks a child", `bun -e 'Bun.spawnSync(["sleep", "30"])'`],
  ])(
    "%s that outlives its shell is killed inside the bound",
    async (_written, command) => {
      const started = Date.now();
      const verdict = await ran(command, 2);

      expect(messages(verdict)).toEqual([containing("was still running after 2s and was killed")]);
      expect(messages(verdict)[0]).toContain("along with everything it had started");
      expect(Date.now() - started).toBeLessThan(12_000);
    },
    20_000,
  );

  // A probe that has already answered must not hold the step open for the rest
  // of its bound: the timer is cleared, so this returns in about the time the
  // command took rather than in the two minutes it was allowed.
  test("a command that finishes early does not wait out its bound", async () => {
    const started = Date.now();
    await ran("true", 30);

    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  // What the probe writes to stdout is read back as prose, so a command whose
  // output arrives wrapped in escape codes reports problems nobody can match to
  // a route. The two variables below are the ones a developer sets for their own
  // shell and forgets.
  test("the command is given a plain environment, whatever the caller's was", async () => {
    process.env["FORCE_COLOR"] = "1";
    try {
      const verdict = await ran(
        'echo "FORCE_COLOR=${FORCE_COLOR:-unset} NO_COLOR=${NO_COLOR:-unset} TERM=${TERM:-unset}"; exit 1',
      );

      expect(messages(verdict)).toEqual(["FORCE_COLOR=unset NO_COLOR=1 TERM=dumb"]);
    } finally {
      delete process.env["FORCE_COLOR"];
    }
  });

  test("the command is told where the app is, under the name every other step uses", async () => {
    const verdict = await ran(`echo "$${APP_URL}"; exit 1`);

    expect(messages(verdict)).toEqual([URL_OF_THE_APP]);
  });

  // Through bash, which is what makes a pipe or an `&&` mean what the caller
  // wrote. An implementation that split the command on whitespace would run
  // `printf` with `|` and `grep` as arguments and report whatever that did.
  test("the command is shell, so a pipe is a pipe", async () => {
    const verdict = await ran(`printf 'a\\nb\\n' | grep b && echo piped; exit 1`);

    expect(messages(verdict)).toEqual(["b", "piped"]);
  });

  // The environment already asks every child not to colour, and a probe that
  // colours unconditionally writes the escapes anyway — they would arrive
  // inside the annotation as the literal bytes `ESC[31m`, against a route name
  // nobody can now search for.
  test("a probe that colours its output anyway does not colour the annotations", async () => {
    const verdict = await ran(
      String.raw`printf '\033[31mGET /presets/1 answered 500\033[0m\n'; exit 1`,
    );

    expect(messages(verdict)).toEqual(["GET /presets/1 answered 500"]);
    // The log keeps what the command actually wrote; only the annotation is stripped.
    expect(verdict.log).toContain("\u001B[31m");
  });

  // Four thousand annotations render as neither a list nor a page. A probe that
  // dumps a log is a program reporting something else, and the whole of it is
  // on the log either way.
  test("a probe that writes a great many lines annotates the first of them and says so", async () => {
    const verdict = await ran(`seq 1 200; exit 1`);

    expect(verdict.problems).toHaveLength(51);
    expect(messages(verdict)[0]).toBe("1");
    expect(messages(verdict)[49]).toBe("50");
    expect(messages(verdict)[50]).toContain("wrote 200 lines to stdout and the first 50 are above");
    expect(verdict.log).toContain("200");
  });

  test("the command runs in the project the caller declared", async () => {
    const root = await materialise({ "marker.txt": "here" });
    const verdict = await ran("ls marker.txt; exit 1", DEFAULT_SECONDS, root);

    expect(messages(verdict)).toEqual(["marker.txt"]);
  });
  // Half a pair is a caller who wrote an input nothing would have read. The
  // step is selected by either input precisely so that this can be said out
  // loud rather than skipped in silence.
  test("a bound with no command under it is refused", async () => {
    const verdict = await probeGate({
      root: ".",
      command: "",
      url: URL_OF_THE_APP,
      seconds: 300,
    });

    expect(messages(verdict)).toEqual([
      containing("probe-timeout is set to 300s and probe-command is empty"),
    ]);
  });
});

describe("where the probe is pointed", () => {
  // Required by the action and defaulted by the workflow, so empty is a caller
  // who wrote an empty string. Running the repo's assertions against no app and
  // reporting what they said is worse than stopping.
  test("an empty health-url is refused rather than handed over as one", () => {
    expect(() => appUrlFrom("")).toThrow("health-url is empty");
  });

  test("a URL is handed over as it was written", () => {
    expect(appUrlFrom(URL_OF_THE_APP)).toBe(URL_OF_THE_APP);
  });
});

describe("the bound the probe is given", () => {
  test("a caller that named none gets the one this gate declares", () => {
    expect(secondsFrom("")).toBe(DEFAULT_SECONDS);
  });

  test("a whole number of seconds is the bound", () => {
    expect(secondsFrom("45")).toBe(45);
  });

  // Refused rather than defaulted, for the reason `upgrade-gate`'s two words
  // are: a spelling that quietly became some other number would kill a probe
  // under a bound nobody wrote, and its author would go looking at the app.
  // The arithmetic the ceiling exists for: `setTimeout` holds its delay in a
  // signed 32-bit integer, so 2147484s overflows to 1ms and the probe is killed
  // the instant it starts — under a diagnostic saying it ran too long. A caller
  // writing a very large number means "effectively no bound" and would get the
  // tightest one there is.
  test.each([3601, 2_147_484, 999_999_999])("%p seconds is longer than this takes", (written) => {
    expect(() => secondsFrom(String(written))).toThrow("longer than the 3600s this takes");
  });

  test("the bound the ceiling allows is still a bound", () => {
    expect(secondsFrom("3600")).toBe(3600);
  });

  test.each(["thirty", "1.5", "0", "-5", "30s", " 30"])(
    "%p is not a bound and is refused rather than read as one",
    (written) => {
      expect(() => secondsFrom(written)).toThrow("whole number of seconds");
    },
  );
});
