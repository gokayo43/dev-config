/**
 * The install, and the key a private git dependency needs to reach (#101).
 *
 * One composite action owns both, so what is graded here is that action's own
 * shell run for real, plus two properties of the workflow that calls it. The
 * shell is where every mistake that matters lives: a key `ssh` cannot read, a
 * `known_hosts` it cannot find a host in, a rewrite that misses the spelling
 * Bun uses, a credential still readable after the command it was for. Each is
 * a red install in every consuming repo, or a key outliving its step, and
 * green here without a case that runs the thing.
 *
 * `bun` is faked at the install itself and nowhere else (`BUN_SHIM`): what the
 * cases need to see is the environment and the key as they stood at the moment
 * `bun install` was handed them, which is the one thing the real command would
 * consume and not report. Everything asserted about those values is asserted
 * with the tool that reads them for real — `ssh-keygen -y`, `ssh-keygen -F`,
 * `git ls-remote --get-url` — never a string comparison against the script.
 *
 * `META` is what `https://api.github.com/meta` answered on 2026-09-11, captured
 * rather than typed: the shape of that answer is GitHub's, not this repo's.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { knownHosts } from "../.github/actions/install/known-hosts.ts";

const CHECK = new URL("../.github/workflows/check.yml", import.meta.url).pathname;

const ACTION_DIRECTORY = new URL("../.github/actions/install/", import.meta.url).pathname;

const DOCUMENT = record(Bun.YAML.parse(await Bun.file(CHECK).text()));

const JOBS = record(DOCUMENT["jobs"]);

const SECRETS = record(record(record(DOCUMENT["on"])["workflow_call"])["secrets"]);

/** One string field of a mapping, or the empty string — a key absent reads as unset. */
function textAt(held: ConfigObject, key: string): string {
  const value = held[key];
  return typeof value === "string" ? value : "";
}

function stepsOf(job: unknown): ConfigObject[] {
  const steps = record(job)["steps"];
  return (isList(steps) ? [...steps] : []).map((step) => record(step));
}

/** The action's one step, as the shipped `action.yml` spells it. */
const ACTION = record(Bun.YAML.parse(await Bun.file(join(ACTION_DIRECTORY, "action.yml")).text()));

const ACTION_STEPS = (() => {
  const steps = record(ACTION["runs"])["steps"];
  return (isList(steps) ? [...steps] : []).map((step) => record(step));
})();

const SCRIPT = textAt(ACTION_STEPS[0] ?? {}, "run");

/** What `https://api.github.com/meta` answers, as far as this action reads it. */
interface Meta {
  readonly ssh_keys: readonly string[];
}

const META: Meta = {
  ssh_keys: [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
  ],
};

interface Ran {
  readonly status: number;
  readonly output: string;
}

async function ran(
  argv: readonly string[],
  environment: Record<string, string>,
  cwd?: string,
): Promise<Ran> {
  const proc = Bun.spawn([...argv], {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, output: out + err };
}

/**
 * A `bun` that answers `install` by recording what it was handed and doing
 * nothing, and that is the real one for every other call — the action runs the
 * host-key reader through it too, and faking that would leave the wiring
 * between the two untested.
 */
const BUN_SHIM = `#!/bin/sh
if [ "$1" = "install" ]; then
  env > "$RECORD/environment"
  if [ -f "$RUNNER_TEMP/git-ssh-key" ]; then
    cp "$RUNNER_TEMP/git-ssh-key" "$RECORD/key"
    stat -c %a "$RUNNER_TEMP/git-ssh-key" > "$RECORD/key-mode"
  fi
  exit 0
fi
exec "$REAL_BUN" "$@"
`;

interface Install extends AsyncDisposable {
  readonly status: number;
  readonly output: string;
  /** The environment `bun install` was handed, or empty where it never ran. */
  readonly environment: Record<string, string>;
  /** The key file as it stood when `bun install` was handed it. */
  readonly keyAtInstall: string | undefined;
  readonly keyModeAtInstall: string | undefined;
  readonly runnerTemp: string;
  readonly knownHosts: string;
  /** The public half of the key the fixture generated, as `ssh-keygen` prints it. */
  readonly publicKey: string;
  /** Whether the key file still exists now the action's shell has exited. */
  keyRemains(): Promise<boolean>;
}

/** What a case hands the action in place of the caller's secret. */
type Secret = "a real key" | "whitespace" | "none";

/**
 * The action's own script run for real: a generated key where the secret goes,
 * a server of the fixture's own where `api.github.com` goes, and a scratch
 * `RUNNER_TEMP` where the runner's is.
 */
async function installed(secret: Secret, published: Meta = META): Promise<Install> {
  const directory = await mkdtemp(join(tmpdir(), "private-git-dependency-"));
  const recordDirectory = join(directory, "record");
  const bin = join(directory, "bin");
  await mkdir(recordDirectory);
  await mkdir(bin);
  await writeFile(join(bin, "bun"), BUN_SHIM);
  await chmod(join(bin, "bun"), 0o755);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json(published),
  });

  const generated = join(directory, "generated");
  await ran(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "fixture", "-q", "-f", generated], {});
  const whole = await Bun.file(generated).text();
  const keys = {
    // GitHub strips the trailing newline off every secret, which is the whole
    // reason the action writes one back.
    "a real key": whole.trimEnd(),
    whitespace: "   ",
    none: "",
  } satisfies Record<Secret, string>;

  const runnerTemp = join(directory, "runner-temp");
  await mkdir(runnerTemp);
  const { status, output } = await ran(
    ["bash", "-c", SCRIPT],
    {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      REAL_BUN: process.execPath,
      RECORD: recordDirectory,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ACTION_PATH: ACTION_DIRECTORY,
      GIT_SSH_KEY: keys[secret],
      INPUT_GITHUB_TOKEN: "fixture-token",
      INPUT_META_URL: server.url.href,
    },
    directory,
  );

  const readOptional = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  };

  const environmentText = (await readOptional(join(recordDirectory, "environment"))) ?? "";

  return {
    status,
    output,
    environment: Object.fromEntries(
      environmentText
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ),
    keyAtInstall: await readOptional(join(recordDirectory, "key")),
    keyModeAtInstall: (await readOptional(join(recordDirectory, "key-mode")))?.trim(),
    runnerTemp,
    knownHosts: join(runnerTemp, "known_hosts"),
    publicKey: (await Bun.file(`${generated}.pub`).text()).split(" ").slice(0, 2).join(" "),
    async keyRemains(): Promise<boolean> {
      try {
        await stat(join(runnerTemp, "git-ssh-key"));
        return true;
      } catch {
        return false;
      }
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The `GIT_CONFIG_*` family alone, which is what a git child reads the rewrite out of. */
function gitConfig(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => name.startsWith("GIT_CONFIG_")),
  );
}

describe("what the workflow asks the action for", () => {
  // Optional is the whole of the no-secret path: a caller with no private
  // dependency passes nothing, and the action installs the way it always did.
  // Required would turn every repo in the fleet red.
  test("is a secret the caller may pass and may leave out", () => {
    expect(record(SECRETS["git-ssh-key"])["required"]).toBe(false);
  });

  // The secrets context is not available in a step's `if` — GitHub's own rule
  // is that secrets cannot be directly referenced in one — so a step gated that
  // way is gated on nothing. The action decides in its body instead, which is
  // the form this workflow's own guard step already uses.
  test("no step decides anything by reading the secrets context in an `if`", () => {
    for (const [name, job] of Object.entries(JOBS)) {
      for (const step of stepsOf(job)) {
        expect(textAt(step, "if"), `${name}: ${textAt(step, "name")}`).not.toContain("secrets");
      }
    }
  });
});

describe("the action, run", () => {
  // Two wrong implementations, and ssh refuses both: `printf '%s'` writes a key
  // whose last line has no newline, which loads as "error in libcrypto" (GitHub
  // strips that newline from the secret, so the action has to put it back), and
  // a write without the umask leaves a 644 key ssh reports as unprotected. Read
  // as `bun install` was handed it, because a key that is right only before or
  // only after the command it is for is no key at all. `ssh-keygen -y` is ssh's
  // own reader rather than a string comparison.
  test("hands the install a key ssh can read, and no other user can", async () => {
    await using run = await installed("a real key");
    expect(run.status).toBe(0);
    expect(run.keyModeAtInstall).toBe("600");

    const at = join(run.runnerTemp, "handed-over");
    await writeFile(at, run.keyAtInstall ?? "");
    await chmod(at, 0o600);
    const read = await ran(["ssh-keygen", "-y", "-f", at], {});
    expect(read.status).toBe(0);
    expect(read.output.split(" ").slice(0, 2).join(" ")).toBe(run.publicKey);
  });

  // The runner is a shared, persistent machine, so a key left in RUNNER_TEMP is
  // a key another repo's job can read. The wrong implementation removes it on
  // the success path alone — which is the same as never, since a job that fails
  // is exactly the job that stops early.
  test("leaves no key behind, whether the install passed or failed", async () => {
    await using passed = await installed("a real key");
    expect(passed.status).toBe(0);
    expect(await passed.keyRemains()).toBe(false);

    await using refused = await installed("whitespace");
    expect(refused.status).not.toBe(0);
    expect(await refused.keyRemains()).toBe(false);
  });

  // Two wrong implementations. Writing the published keys as they arrive: a
  // known_hosts line is `<host> <key>`, so a file of bare keys matches no host
  // at all — and with StrictHostKeyChecking=yes, which the action also exports
  // because Bun's own default of accept-new is gone the moment GIT_SSH_COMMAND
  // is set, every clone is refused. Naming `github.com` alone: a machine whose
  // outbound :22 is closed reaches GitHub as `[ssh.github.com]:443` through its
  // own ssh config, and that name matches no line. `ssh-keygen -F` is ssh's own
  // lookup rather than a string comparison.
  test("hands the install a known_hosts ssh finds github.com in, and the options that decide", async () => {
    await using run = await installed("a real key");
    for (const host of ["github.com", "[ssh.github.com]:443"]) {
      const found = await ran(["ssh-keygen", "-F", host, "-f", run.knownHosts], {});
      expect(found.status, host).toBe(0);
      for (const published of META.ssh_keys) expect(found.output, host).toContain(published);
    }

    const command = run.environment["GIT_SSH_COMMAND"] ?? "";
    expect(command).toContain(`-i ${join(run.runnerTemp, "git-ssh-key")}`);
    expect(command).toContain(`-o UserKnownHostsFile=${run.knownHosts}`);
    expect(command).toContain("-o StrictHostKeyChecking=yes");
    expect(command).toContain("-o IdentitiesOnly=yes");
  });

  // The rewrite as git performs it, not as the script spells it: `ls-remote
  // --get-url` expands insteadOf and talks to nothing. The wrong implementation
  // rewrites the bare base alone — and the URL Bun builds for a git+ssh://
  // dependency keeps its userinfo, so that one rewrites nothing at all and
  // every install goes on printing the failed HTTPS attempt it exists to remove.
  test("hands the install a rewrite git applies to both spellings of the base", async () => {
    await using run = await installed("a real key");
    for (const url of [
      "https://git@github.com/gokayo43/nfp-elysia-storefront-types.git",
      "https://github.com/gokayo43/nfp-elysia-storefront-types.git",
    ]) {
      const expanded = await ran(
        ["git", "ls-remote", "--get-url", url],
        gitConfig(run.environment),
      );
      expect(expanded.status).toBe(0);
      expect(expanded.output.trim()).toBe(
        "ssh://git@github.com/gokayo43/nfp-elysia-storefront-types.git",
      );
    }
  });

  // A secret that is not a key used to reach `bun install` intact and fail
  // three commands later as `Permission denied (publickey)`, which reads as a
  // deploy key nobody added rather than as a secret pasted wrong. `ssh-keygen
  // -y` is the same reader ssh will use, so what it refuses here is exactly
  // what would have failed there.
  test("refuses a secret that is not a key, by name, before installing anything", async () => {
    await using run = await installed("whitespace");
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("git-ssh-key");
    expect(run.environment["GIT_SSH_COMMAND"]).toBeUndefined();
  });

  // The no-secret path, which is every repo in the fleet with no private
  // dependency: the install still happens, and nothing about it changes. The
  // wrong implementation writes a key file from an empty secret, or exports a
  // GIT_SSH_COMMAND naming one, and a repo that passed nothing then installs
  // under an ssh identity that does not exist.
  test("installs with no key at all when the caller passed none", async () => {
    await using run = await installed("none");
    expect(run.status).toBe(0);
    expect(run.environment["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(run.environment["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(run.keyAtInstall).toBeUndefined();
    expect(await run.keyRemains()).toBe(false);
  });
});

describe("the host keys the action decides against", () => {
  // The endpoint is the one thing here nobody in this fleet owns. An answer
  // with no keys in it would write an empty known_hosts, which
  // StrictHostKeyChecking then refuses every clone against — a red install
  // blaming the dependency rather than the fetch. It fails where it is read.
  test("an answer with no host keys in it fails where it is read", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({}) });
    try {
      expect(knownHosts(server.url.href, "fixture-token")).rejects.toThrow("published no ssh_keys");
    } finally {
      await server.stop(true);
    }
  });

  // A 403 is what the unauthenticated ceiling on that endpoint looks like — 60
  // an hour per IP, which every runner on one host shares. It must say which
  // call failed rather than leave an empty known_hosts behind it.
  test("a refused answer fails where it is read, naming the status", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("rate limited", { status: 403 }),
    });
    try {
      expect(knownHosts(server.url.href, "fixture-token")).rejects.toThrow("403");
    } finally {
      await server.stop(true);
    }
  });

  // The token is what keeps the call off that shared ceiling. Sending it as a
  // bearer is the whole of the fix, and an unauthenticated reader passes every
  // other case in this file.
  test("is read with the caller's token", async () => {
    const sent: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        sent.push(request.headers.get("authorization"));
        return Response.json(META);
      },
    });
    try {
      await knownHosts(server.url.href, "fixture-token");
      expect(sent).toEqual(["Bearer fixture-token"]);
    } finally {
      await server.stop(true);
    }
  });

  // A known_hosts line is `<host> <key>`, and both names GitHub answers on have
  // to be on it.
  test("names both endpoints on every key it writes", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(META) });
    try {
      const written = await knownHosts(server.url.href, "fixture-token");
      expect(written.split("\n").filter((line) => line !== "")).toHaveLength(META.ssh_keys.length);
      for (const key of META.ssh_keys) {
        expect(written).toContain(`github.com,[ssh.github.com]:443 ${key}\n`);
      }
    } finally {
      await server.stop(true);
    }
  });
});
