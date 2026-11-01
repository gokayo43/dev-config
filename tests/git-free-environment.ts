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

// git hands a command it runs the repository it is acting on. No hook of this
// repo runs the suite, but `git rebase --exec 'bun test'` does: from a linked
// worktree it hands the command `GIT_DIR`, absolute, beside `GIT_EXEC_PATH`,
// `GIT_PREFIX`, `GIT_SEQUENCE_EDITOR` and `GIT_CHERRY_PICK_HELP`, and no index.
// A developer's own `pre-push` hook gets the same `GIT_DIR`, and `pre-commit`
// also `GIT_INDEX_FILE` and the `GIT_AUTHOR_*` (githooks(7); probed against
// git 2.43.0, where `git bisect run` hands its command none). `GIT_DIR`
// outranks the working directory a child is given, so without this the fixtures
// are built inside the repository git acts on: `git init` with no work tree
// makes it bare, and every fixture commit rewrites its branch.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}

// `Bun.spawn`'s `env` defaults to the environment block the process launched
// with. That is by design and by declaration — "Changes to `process.env` at
// runtime won't automatically be reflected in the default value. For that, you
// can pass `process.env` explicitly" (bun-types, `SpawnOptions.BaseOptions`) —
// so the removal above reaches a child only where the site passes it. Making
// bun's own remedy the default is what carries it to the sites that state no
// `env`, four of which run git, and to everything those in turn spawn. One
// variable travels the other way for the same reason: `bun test` sets
// `NODE_ENV` after launch, and it is now in what those children are given.
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
