/**
 * The seam that lets a repo with a private git dependency install at all
 * (dev-config#101): a secret the caller may pass, written to `RUNNER_TEMP`
 * before each `bun install` and removed after it.
 *
 * It is shipped workflow rather than a module, so it is graded the way the
 * `affected` seam is — the YAML for what only GitHub can evaluate, and the
 * step's own shell run for real for everything else. What the run proves is
 * the half nothing else here can see: `ssh` reads the key file it wrote,
 * `ssh-keygen` finds the host in the `known_hosts` it wrote, and `git` really
 * rewrites the URL Bun is about to hand it. A step that writes an unreadable
 * key, or a rewrite that misses the spelling Bun uses, is a red install in
 * every consuming repo and green here without them.
 *
 * `META` is what `https://api.github.com/meta` answered on 2026-09-10, captured
 * rather than typed: the shape of that answer is GitHub's, not this repo's.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";

const CHECK = new URL("../.github/workflows/check.yml", import.meta.url).pathname;

const DOCUMENT = record(Bun.YAML.parse(await Bun.file(CHECK).text()));

const JOBS = record(DOCUMENT["jobs"]);

const SECRETS = record(record(record(DOCUMENT["on"])["workflow_call"])["secrets"]);

const INSTALL = "bun install --frozen-lockfile";

const KEY_STEP = "Authorise the private git dependency";

/** One string field of a mapping, or the empty string — a key absent reads as unset. */
function textAt(held: ConfigObject, key: string): string {
  const value = held[key];
  return typeof value === "string" ? value : "";
}

function stepsOf(job: unknown): ConfigObject[] {
  const steps = record(job)["steps"];
  return (isList(steps) ? [...steps] : []).map((step) => record(step));
}

/**
 * The jobs that install, found by the command rather than named here: a third
 * job that installs is a third job that needs the key, and a list in this file
 * is the copy that goes stale the day one is added.
 */
const INSTALLS = Object.entries(JOBS).filter(([, job]) =>
  stepsOf(job).some((step) => textAt(step, "run").trim() === INSTALL),
);

/** The step's own shell, taken out of the job that ships it. */
function scriptOf(name: string): string {
  const step = INSTALLS.flatMap(([, job]) => stepsOf(job)).find(
    (each) => textAt(each, "name") === name,
  );
  if (step === undefined) throw new Error(`check.yml has no step named ${JSON.stringify(name)}`);
  return textAt(step, "run");
}

/** What `https://api.github.com/meta` answers, as far as this step reads it. */
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

async function ran(argv: readonly string[], environment: Record<string, string>): Promise<Ran> {
  const proc = Bun.spawn([...argv], {
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

interface Authorised extends AsyncDisposable {
  readonly status: number;
  readonly output: string;
  /** What the step exported for the rest of the job, as the file it appends to spells it. */
  readonly exported: Record<string, string>;
  readonly key: string;
  readonly knownHosts: string;
  /** The public half of the key the fixture generated, as `ssh-keygen` prints it. */
  readonly publicKey: string;
}

/**
 * The step run for real: a generated key where the secret goes, a server of the
 * fixture's own where `api.github.com` goes, and a scratch `RUNNER_TEMP` and
 * `GITHUB_ENV` where the runner's are.
 */
async function authorised(published: Meta = META): Promise<Authorised> {
  const directory = await mkdtemp(join(tmpdir(), "private-git-dependency-"));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json(published),
  });
  const generated = join(directory, "generated");
  await ran(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "fixture", "-q", "-f", generated], {});
  const secret = await Bun.file(generated).text();
  const githubEnv = join(directory, "github-env");
  await Bun.write(githubEnv, "");
  const { status, output } = await ran(["bash", "-c", scriptOf(KEY_STEP)], {
    RUNNER_TEMP: directory,
    GITHUB_ENV: githubEnv,
    GITHUB_META_URL: server.url.href,
    // GitHub strips the trailing newline off every secret, which is the whole
    // reason the step writes one back.
    GIT_SSH_KEY: secret.trimEnd(),
  });
  const exported = Object.fromEntries(
    (await Bun.file(githubEnv).text())
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    status,
    output,
    exported,
    key: join(directory, "git-ssh-key"),
    knownHosts: join(directory, "known_hosts"),
    publicKey: (await Bun.file(`${generated}.pub`).text()).split(" ").slice(0, 2).join(" "),
    async [Symbol.asyncDispose](): Promise<void> {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The `GIT_CONFIG_*` family alone, which is what a git child reads the rewrite out of. */
function gitConfig(exported: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(exported).filter(([name]) => name.startsWith("GIT_CONFIG_")),
  );
}

describe("the key a private git dependency is installed with", () => {
  // Optional is the whole of the no-secret path: a caller with no private
  // dependency passes nothing, the job-level word is false, and both steps
  // below never run. Required would turn every repo in the fleet red.
  test("is a secret the caller may pass and may leave out", () => {
    expect(record(SECRETS["git-ssh-key"])["required"]).toBe(false);
  });

  // The wrong implementation is the readable one: `if: ${{ secrets['git-ssh-key']
  // != '' }}`. The secrets context is not available in a step's `if` — GitHub's
  // own rule is that secrets cannot be directly referenced in one — so the step
  // would be gated on nothing and the key never written.
  test("is read in an `if` through a job-level word, never through the secrets context", () => {
    for (const [name, job] of INSTALLS) {
      expect(record(record(job)["env"])["HAS_GIT_SSH_KEY"], name).toBe(
        "${{ secrets['git-ssh-key'] != '' }}",
      );
    }
    for (const [name, job] of Object.entries(JOBS)) {
      for (const step of stepsOf(job)) {
        expect(textAt(step, "if"), `${name}: ${textAt(step, "name")}`).not.toContain("secrets");
      }
    }
  });

  // Found by position rather than by presence: a step that writes the key after
  // the install has written it for nothing, which is the failure #101 is about
  // wearing a green diff.
  test("is written by the step immediately before every install", () => {
    for (const [name, job] of INSTALLS) {
      const steps = stepsOf(job);
      const at = steps.findIndex((step) => textAt(step, "run").trim() === INSTALL);
      const before = steps[at - 1] ?? {};
      expect(textAt(before, "name"), name).toBe(KEY_STEP);
      expect(textAt(before, "if"), name).toBe("env.HAS_GIT_SSH_KEY == 'true'");
    }
  });

  // The runner is a shared, persistent machine, so a key left in RUNNER_TEMP is
  // a key another repo's job can read. The wrong implementation removes it in
  // the static job alone, or without `always()`, which is the same thing on
  // every run that fails — and a failing run is exactly when a job stops early.
  test("is removed by a last step of every job that wrote one", () => {
    for (const [name, job] of INSTALLS) {
      const steps = stepsOf(job);
      const last = steps.at(-1) ?? {};
      expect(textAt(last, "if"), name).toBe("always() && env.HAS_GIT_SSH_KEY == 'true'");
      expect(textAt(last, "run"), name).toContain('rm -f "$RUNNER_TEMP/git-ssh-key"');
    }
  });
});

describe("what the step leaves the job", () => {
  // Two wrong implementations, and ssh refuses both: `printf '%s'` writes a key
  // whose last line has no newline, which loads as "error in libcrypto" (GitHub
  // strips that newline from the secret, so the step has to put it back), and a
  // write without the umask leaves a 644 key ssh reports as unprotected.
  // `ssh-keygen -y` is ssh's own reader rather than a string comparison here.
  test("a key file ssh can read, and no other user can", async () => {
    await using run = await authorised();
    expect(run.status).toBe(0);
    expect((await stat(run.key)).mode & 0o777).toBe(0o600);
    const read = await ran(["ssh-keygen", "-y", "-f", run.key], {});
    expect(read.status).toBe(0);
    expect(read.output.split(" ").slice(0, 2).join(" ")).toBe(run.publicKey);
  });

  // Two wrong implementations. Writing the published keys as they arrive: a
  // known_hosts line is `<host> <key>`, so a file of bare keys matches no host
  // at all — and with StrictHostKeyChecking=yes, which the step also exports
  // because Bun's own default of accept-new is gone the moment GIT_SSH_COMMAND
  // is set, every clone is refused. Naming `github.com` alone: a machine whose
  // outbound :22 is closed reaches GitHub as `[ssh.github.com]:443` through its
  // own ssh config, and that name matches no line. `ssh-keygen -F` is ssh's own
  // lookup rather than a string comparison.
  test("a known_hosts ssh finds github.com in, and the options that make it decide", async () => {
    await using run = await authorised();
    for (const host of ["github.com", "[ssh.github.com]:443"]) {
      const found = await ran(["ssh-keygen", "-F", host, "-f", run.knownHosts], {});
      expect(found.status, host).toBe(0);
      for (const published of META.ssh_keys) expect(found.output, host).toContain(published);
    }

    const command = run.exported["GIT_SSH_COMMAND"] ?? "";
    expect(command).toContain(`-i ${run.key}`);
    expect(command).toContain(`-o UserKnownHostsFile=${run.knownHosts}`);
    expect(command).toContain("-o StrictHostKeyChecking=yes");
    expect(command).toContain("-o IdentitiesOnly=yes");
  });

  // The rewrite as git performs it, not as the file spells it: `ls-remote
  // --get-url` expands insteadOf and talks to nothing. The wrong implementation
  // rewrites the bare base alone — and the URL Bun builds for a git+ssh://
  // dependency keeps its userinfo, so that one rewrites nothing at all and
  // every install goes on printing the failed HTTPS attempt it exists to remove.
  test("a rewrite git applies to both spellings of the base", async () => {
    await using run = await authorised();
    for (const url of [
      "https://git@github.com/gokayo43/nfp-elysia-storefront-types.git",
      "https://github.com/gokayo43/nfp-elysia-storefront-types.git",
    ]) {
      const expanded = await ran(["git", "ls-remote", "--get-url", url], gitConfig(run.exported));
      expect(expanded.status).toBe(0);
      expect(expanded.output.trim()).toBe(
        "ssh://git@github.com/gokayo43/nfp-elysia-storefront-types.git",
      );
    }
  });

  // The endpoint is the one thing here nobody in this fleet owns. An answer with
  // no keys in it would write an empty known_hosts, which StrictHostKeyChecking
  // then refuses every clone against — a red install blaming the dependency
  // rather than the fetch. It fails where it is read instead.
  test("a meta answer with no host keys in it fails the step rather than the install", async () => {
    await using run = await authorised({ ssh_keys: [] });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("published no ssh_keys");
  });
});
