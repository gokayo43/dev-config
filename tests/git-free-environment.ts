/**
 * The environment every test file and every process the suite spawns is given,
 * established before the first of them loads. `bunfig.toml` names it as the
 * test runner's preload; `tests/git-free-environment.test.ts` grades it from
 * outside, against a repository a run must not touch.
 *
 * Nothing here is an allowlist. Every git fact a fixture needs it states itself
 * — `tests/tree.ts` dates its own commits and names its own committer — so a
 * `GIT_` variable arriving from outside is never one this suite meant to read,
 * and the whole prefix goes rather than the set a hook is known to carry.
 */

// git exports the repository a hook is acting on to that hook: from a linked
// worktree, `GIT_DIR` and `GIT_INDEX_FILE` absolute (githooks(7), probed
// against git 2.43). `GIT_DIR` outranks the working directory a child is given,
// so a suite run from lefthook's `pre-push` builds its fixtures inside the
// repository being pushed — `git init` with no work tree making it bare, every
// fixture commit rewriting its branch.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}

// bun documents `Bun.spawn`'s `env` as defaulting to `process.env`, but on bun
// 1.4.0 that default is the block the process started with: probed, neither
// deleting from `process.env` nor libc `unsetenv` reaches a child spawned
// without an `env` of its own. Honouring the documented default is what carries
// the removal above to the spawn sites that state no environment — four of them
// run git — and to everything those in turn spawn.
const inherited = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };

type Streamed = Bun.SpawnOptions.Writable & Bun.SpawnOptions.Readable;
type Started = Bun.SpawnOptions.BaseOptions<Streamed, Streamed, Streamed>;
type Async = Bun.SpawnOptions.SpawnOptions<Streamed, Streamed, Streamed>;
type Sync = Bun.SpawnOptions.SpawnSyncOptions<Streamed, Streamed, Streamed>;

/** The options as the caller wrote them, with the environment they left out filled in. */
function stated<Given extends Started>(options: Given): Given {
  return { ...options, env: options.env ?? process.env };
}

// Both public call forms, since which one a site uses is the caller's choice
// and neither is this module's business: the command first and the options
// second, or one object carrying both.
//
// Each wrapper answers with what the function it replaces answered; the
// assertion is that a single signature stands in for an overloaded one, which
// no caller reads from here — every one of them is compiled against bun's own
// declaration, and that this does not touch.
Bun.spawn = ((first: string[] | (Async & { cmd: string[] }), second?: Async) =>
  Array.isArray(first)
    ? inherited.spawn(first, stated(second ?? {}))
    : inherited.spawn(stated(first))) as typeof Bun.spawn;

Bun.spawnSync = ((first: string[] | (Sync & { cmd: string[]; onExit?: never }), second?: Sync) =>
  Array.isArray(first)
    ? inherited.spawnSync(first, stated(second ?? {}))
    : inherited.spawnSync(stated(first))) as typeof Bun.spawnSync;
