import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import type {
  BrowserContext,
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  Request,
  TestInfo,
  TestType,
} from "@playwright/test";

import {
  command,
  COUNTS,
  type Count,
  type Counts,
  described,
  entryIn,
  isBroken,
  isJson,
  type Json,
  lowered,
  MODE,
  type Where,
  withEntry,
} from "./count-ceilings.ts";
import { type InvariantSweep, test as swept } from "./invariant-sweep.ts";

export type { Counts } from "./count-ceilings.ts";

const STILL = 2;
const ROUNDS = 100;

/** A round whose idle callback waited this long found the page busy, and counts as one in which the page moved. */
const BUSY_MS = 100;

const PAGE_STATE = "__countBudget";
const REPORTER = "__countBudgetReport";

/**
 * What Playwright says when the document an `evaluate` ran in was replaced
 * before it answered.
 */
const REPLACED = "Execution context was destroyed";

/**
 * Installed in every document of the test's page before any of its scripts.
 *
 * React calls `onCommitFiberRoot` on the DevTools global hook once per commit,
 * production builds included, provided the hook exists before React loads and
 * answers `supportsFiber`; the no-op methods are the rest of what React calls on
 * it. React skips a hook whose `isDisabled` is true, so turning it off, or
 * putting another object in its place, is recorded and refused rather than
 * read as a page with no React.
 *
 * A document also reports itself after every task that changed it, because the
 * one it replaces is gone before the test can ask: a binding called from
 * `pagehide` arrives after Playwright has dropped the document it came from.
 */
const INSTRUMENT = `(() => {
  if (window.top !== window) return;
  const state = { document: Math.random().toString(36).slice(2), react: false, hookOff: false, reactCommits: 0, mutationRecords: 0 };
  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; window.${REPORTER}(read()); });
  };
  const observer = new MutationObserver((records) => { state.mutationRecords += records.length; changed(); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const read = () => {
    state.mutationRecords += observer.takeRecords().length;
    return { ...state };
  };
  Object.defineProperty(window, "${PAGE_STATE}", { value: read });
  const renderers = new Map();
  const off = () => { state.hookOff = true; changed(); };
  const hook = {
    renderers,
    supportsFiber: true,
    get isDisabled() { return state.hookOff; },
    set isDisabled(value) { if (value) off(); },
    inject(renderer) {
      state.react = true;
      renderers.set(renderers.size + 1, renderer);
      changed();
      return renderers.size;
    },
    onCommitFiberRoot() { state.reactCommits += 1; changed(); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    setStrictMode() {},
    checkDCE() {},
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { get: () => hook, set: off });
})();`;

const ROUND = `new Promise((done) => requestIdleCallback((idle) => requestAnimationFrame(() => done({ busy: idle.didTimeout, state: window.${PAGE_STATE} ? window.${PAGE_STATE}() : null })), { timeout: ${BUSY_MS} }))`;

interface DocumentState {
  readonly document: string;
  readonly react: boolean;
  readonly hookOff: boolean;
  readonly reactCommits: number;
  readonly mutationRecords: number;
}

function whole(found: unknown): found is number {
  return typeof found === "number" && Number.isInteger(found) && found >= 0;
}

/** What the instrument says about a document; anything else is refused loudly. */
function documentState(value: unknown): DocumentState {
  if (!isJson(value)) throw new Error(`the page reported ${JSON.stringify(value)} as its counts`);
  const { document, react, hookOff, reactCommits, mutationRecords } = value;
  if (
    typeof document !== "string" ||
    typeof react !== "boolean" ||
    typeof hookOff !== "boolean" ||
    !whole(reactCommits) ||
    !whole(mutationRecords)
  ) {
    throw new Error(`the page reported ${JSON.stringify(value)} as its counts`);
  }
  return { document, react, hookOff, reactCommits, mutationRecords };
}

interface Snapshot {
  /** `null` on the initial `about:blank` a page starts on, which no init script ran in. */
  readonly current: DocumentState | null;
  /** How many documents have held a React renderer, which only grows. */
  readonly reactDocuments: number;
  readonly totals: Record<Count, number>;
}

/** What moved from one snapshot to the next, in words; empty when nothing did. */
function moved(from: Snapshot, to: Snapshot): string {
  const changed = COUNTS.filter((count) => from.totals[count] !== to.totals[count]).map(
    (count) => `${count} ${from.totals[count]} → ${to.totals[count]}`,
  );
  if (from.current?.document !== to.current?.document) changed.push("the document was replaced");
  return changed.join(", ");
}

/**
 * Whether a URL is one the test answers: its own origins, or none at all —
 * a `blob:` URL is the page's own and raises request events like any other.
 */
function servedBy(origins: ReadonlySet<string>, url: string): boolean {
  const { protocol, origin } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return true;
  return origins.has(origin);
}

/** A socket's origin as an HTTP origin, which is how the test names what it serves. */
function socketOrigin(url: string): string {
  const { protocol, host } = new URL(url);
  return `${protocol === "wss:" ? "https:" : "http:"}//${host}`;
}

/** The origins the test serves, each normalised, and a written one that is not a URL refused. */
function originsOf(servedOrigins: readonly string[], baseURL: string | undefined): Set<string> {
  return new Set(
    [...servedOrigins, ...(baseURL === undefined ? [] : [baseURL])].map((written) => {
      let origin: string;
      try {
        ({ origin } = new URL(written));
      } catch (cause) {
        throw new Error(
          `count budget: ${JSON.stringify(written)} in \`servedOrigins\` is not a URL; write the origin the test serves, such as "http://127.0.0.1:8787"`,
          { cause },
        );
      }
      if (origin === "null") {
        throw new Error(
          `count budget: ${JSON.stringify(written)} in \`servedOrigins\` has no origin; write an http(s) origin, such as "http://127.0.0.1:8787"`,
        );
      }
      return origin;
    }),
  );
}

interface Pending {
  readonly label: string;
  /** How many main-frame navigations had started when it was sent. */
  readonly epoch: number;
}

type Round =
  | { readonly kind: "busy" }
  | { readonly kind: "replaced" }
  | { readonly kind: "read"; readonly snapshot: Snapshot };

class Meter {
  readonly #page: Page;
  readonly #origins: ReadonlySet<string>;
  readonly #documents = new Map<string, DocumentState>();
  readonly #network = { requests: 0, bodyBytes: 0, scriptBytes: 0 };
  readonly #pending = new Map<Request, Pending>();
  #epoch = 0;
  #lastDocument: string | undefined;
  readonly #unserved: string[] = [];
  readonly #failures: string[] = [];

  private constructor(page: Page, origins: ReadonlySet<string>) {
    this.#page = page;
    this.#origins = origins;
  }

  static async watching(page: Page, origins: ReadonlySet<string>): Promise<Meter> {
    const meter = new Meter(page, origins);
    await page.exposeBinding(REPORTER, ({ frame }, state: unknown) => {
      if (frame !== page.mainFrame()) return;
      meter.#reported(documentState(state));
    });
    await page.addInitScript(INSTRUMENT);
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) meter.#epoch += 1;
      meter.#network.requests += 1;
      meter.#pending.set(request, {
        label: `${request.method()} ${request.url()}`,
        epoch: meter.#epoch,
      });
    });
    page.on("requestfinished", (request) => void meter.#finished(request));
    page.on("requestfailed", (request) => {
      meter.#failed(request);
      meter.#pending.delete(request);
    });
    // A socket that `page.routeWebSocket` answers without `connectToServer`
    // raises no `websocket` event, so one that does reached its server.
    page.on("websocket", (socket) => {
      if (!origins.has(socketOrigin(socket.url())))
        meter.#unserved.push(`${socket.url()} (WebSocket)`);
    });
    meter.#watchServiceWorkers(page.context());
    return meter;
  }

  /** A service worker's own fetches are reported on the context, never on the page. */
  #watchServiceWorkers(context: BrowserContext): void {
    context.on("requestfinished", (request) => {
      if (request.serviceWorker() === null) return;
      this.#reachedOut(request).catch((error: unknown) => {
        this.#failures.push(
          `${request.url()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    context.on("requestfailed", (request) => {
      if (request.serviceWorker() !== null) this.#failed(request);
    });
  }

  /** A document's counts only grow, so whichever of two reports is behind is the earlier one. */
  #reported(state: DocumentState): void {
    const held = this.#documents.get(state.document);
    this.#documents.set(state.document, {
      document: state.document,
      react: state.react || held?.react === true,
      hookOff: state.hookOff || held?.hookOff === true,
      reactCommits: Math.max(state.reactCommits, held?.reactCommits ?? 0),
      mutationRecords: Math.max(state.mutationRecords, held?.mutationRecords ?? 0),
    });
  }

  #failed(request: Request): void {
    if (!servedBy(this.#origins, request.url())) {
      this.#unserved.push(`${request.url()} (failed: ${request.failure()?.errorText})`);
    }
  }

  /**
   * Playwright gives a response a server address only when it came from a
   * server: one a route fulfilled has none, which is what tells a stub from a
   * request that reached the origin.
   */
  async #reachedOut(request: Request): Promise<void> {
    const response = await request.response();
    if (servedBy(this.#origins, request.url()) || response === null) return;
    if ((await response.serverAddr()) !== null) this.#unserved.push(request.url());
  }

  /**
   * Decoded body bytes, from the body itself. Chromium's encoded size counts a
   * chunked response's framing, which follows how the server split its writes,
   * and misreports a body a route fulfilled (9 bytes for 13).
   */
  async #finished(request: Request): Promise<void> {
    try {
      const response = await request.response();
      if (response === null) throw new Error("a finished request has no response");
      const redirect = response.status() >= 300 && response.status() < 400;
      const bytes = redirect ? 0 : (await response.body()).byteLength;
      this.#network.bodyBytes += bytes;
      if (request.resourceType() === "script") this.#network.scriptBytes += bytes;
      await this.#reachedOut(request);
    } catch (error) {
      this.#failures.push(
        `${request.url()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#pending.delete(request);
    }
  }

  #snapshot(read: DocumentState | null): Snapshot {
    if (read !== null) this.#reported(read);
    const totals = { ...this.#network, reactCommits: 0, mutationRecords: 0 };
    let reactDocuments = 0;
    for (const state of this.#documents.values()) {
      totals.reactCommits += state.reactCommits;
      totals.mutationRecords += state.mutationRecords;
      if (state.react) reactDocuments += 1;
    }
    const current = read === null ? null : (this.#documents.get(read.document) ?? null);
    return { current, reactDocuments, totals };
  }

  async #round(): Promise<Round> {
    let answer: unknown = undefined;
    try {
      answer = await this.#page.evaluate(ROUND);
    } catch (error) {
      if (error instanceof Error && error.message.includes(REPLACED)) return { kind: "replaced" };
      throw error;
    }
    if (!isJson(answer)) throw new Error(`an idle round answered ${JSON.stringify(answer)}`);
    if (answer["busy"] === true) return { kind: "busy" };
    const state = answer["state"] === null ? null : documentState(answer["state"]);
    return { kind: "read", snapshot: this.#snapshot(state) };
  }

  /**
   * Once a navigation has replaced the document, a request the old one sent
   * that is still pending is a keepalive fetch or a beacon: no document is left
   * for its answer to change, and Playwright reports no end for it.
   */
  #orphan(current: string | undefined): void {
    if (current === this.#lastDocument) return;
    this.#lastDocument = current;
    for (const [request, { epoch }] of this.#pending) {
      if (epoch < this.#epoch) this.#pending.delete(request);
    }
  }

  /** Throws the refusal a precondition owes, if one does not hold. */
  refusals(): void {
    if (this.#unserved.length > 0) {
      throw new Error(
        [
          `count budget refused: the page reached an origin the test neither serves nor stubs:`,
          ...[...new Set(this.#unserved)].map((url) => `  ${url}`),
          `A response from somewhere the test does not control lands when it lands, and where two land close together React may commit once or twice, so the counts stop being repeatable. Answer each with page.route(…, (route) => route.fulfill(…)), or page.routeWebSocket for a socket, with a captured payload; or, if the test itself serves that origin, name it in \`servedOrigins\`. Aborting the request is not a stub: it changes what the page does.`,
        ].join("\n"),
      );
    }
    if (this.#failures.length > 0) {
      throw new Error(
        [
          `count budget could not read a response's body:`,
          ...this.#failures.map((failure) => `  ${failure}`),
        ].join("\n"),
      );
    }
    if ([...this.#documents.values()].some((state) => state.hookOff)) {
      throw new Error(
        `count budget refused: the page turned React's DevTools hook off (it set \`__REACT_DEVTOOLS_GLOBAL_HOOK__.isDisabled\`, or replaced the hook), and React does not report a single commit to a hook that is off, so the page would read as one with no React. Leave the hook alone in the build the test serves.`,
      );
    }
  }

  async still(): Promise<Snapshot> {
    let last: Snapshot | undefined;
    let quiet = 0;
    const seen: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const answer = await this.#round();
      this.refusals();
      if (answer.kind !== "read") {
        quiet = 0;
        seen.push(
          answer.kind === "busy"
            ? `the page was busy for a whole round (${BUSY_MS}ms)`
            : "the document was replaced mid-round",
        );
        continue;
      }
      const now = answer.snapshot;
      this.#orphan(now.current?.document);
      const change = last === undefined ? undefined : moved(last, now);
      if (change !== undefined) seen.push(change === "" ? "nothing moved" : change);
      quiet = change === "" && this.#pending.size === 0 ? quiet + 1 : 0;
      if (quiet === STILL) return now;
      last = now;
    }
    const inFlight = [...this.#pending.values()].map(({ label }) => label);
    throw new Error(
      [
        `count budget refused: the page did not go still in ${ROUNDS} idle rounds, so any count read from it would depend on when it was read.`,
        `What moved in the last rounds: ${seen.slice(-3).join("; ")}.`,
        ...(inFlight.length > 0 ? [`Still in flight: ${inFlight.join(", ")}.`] : []),
        `An animation driven from script that ignores prefers-reduced-motion (the fixture emulates "reduce"), a timer that keeps mutating the DOM, or a request that never finishes keeps a page moving; stop it under reduced motion, or stub what never finishes.`,
      ].join("\n"),
    );
  }
}

function phaseCounts(start: Snapshot, end: Snapshot): Counts {
  const react =
    start.current?.react === true ||
    end.current?.react === true ||
    end.reactDocuments > start.reactDocuments;
  const counts: Counts = {};
  for (const count of COUNTS) {
    if (count === "reactCommits" && !react) continue;
    counts[count] = end.totals[count] - start.totals[count];
  }
  return counts;
}

export interface Budget {
  /**
   * Waits for the page to go still, runs `action`, waits again, and records
   * what the page did between the two. A phase that throws, refusals included,
   * fails the test even where the test catches it.
   */
  phase<Answer>(name: string, action: () => Promise<Answer>): Promise<Answer>;
}

/** The fixture and the option a repo sets, declared so `test.use({ servedOrigins })` type-checks. */
export interface CountBudget {
  /**
   * Origins the test serves itself beyond its `baseURL`'s, such as an API it
   * started on a port of its own. A request to any other origin has to be
   * fulfilled by a route.
   */
  servedOrigins: readonly string[];
  budget: Budget;
}

/** Where a spec's ceilings live: beside it, named after it. */
function ceilingsFor(spec: string): string {
  return join(dirname(spec), `${basename(spec, extname(spec))}.counts.json`);
}

function keyOf(testInfo: TestInfo): string {
  const titles = testInfo.titlePath.slice(1).join(" › ");
  return testInfo.project.name === "" ? titles : `[${testInfo.project.name}] › ${titles}`;
}

async function ceilingsAt(path: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isJson(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

function handEdited(where: Where): string {
  return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were edited by hand, because their seal no longer matches the ceilings the command accepted. The command lowers a ceiling; a person raises one only as { "ceiling": <new>, "was": <the ceiling the command accepted>, "reason": "<why the page does more>" }, and then runs ${command(where)} to seal it. Put the numbers back as git has them and make the change in that form.`;
}

function otherBrowser(measuredOn: string, running: string, where: Where): string {
  return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were measured on ${measuredOn}, and this run is ${running}. A count is only comparable on the browser build it was measured on. Re-measure with ${command(where)}, which records this browser and lowers what dropped; a count that rose keeps its ceiling and fails until it is raised by hand with a reason.`;
}

const LOCK_PATIENCE_MS = 10_000;
const LOCK_POLL_MS = 25;

/** When a process started, in clock ticks since boot, where `/proc` says; a reused pid starts later. */
async function startOf(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Whether the process a lock names is gone, so a run killed while writing costs the next one nothing. */
async function abandoned(lock: string): Promise<boolean> {
  let holder: unknown;
  try {
    holder = JSON.parse(await readFile(lock, "utf8"));
  } catch {
    // Released between the failed link and this read, or never whole; a lock
    // that names nobody can never be released by anybody.
    return true;
  }
  if (!isJson(holder) || typeof holder["pid"] !== "number") return true;
  if (!alive(holder["pid"])) return true;
  return holder["start"] !== (await startOf(holder["pid"]));
}

/**
 * Runs `write` holding the file's lock, so workers running tests of one spec in
 * parallel each lower their own entry rather than the last writer's view of the
 * file winning. The holder is written whole and then linked into place, so a
 * lock is never seen half written; one whose holder is gone is taken over, with
 * the half-written file it may have left beside it.
 */
async function locked<Answer>(
  path: string,
  write: (staged: string) => Promise<Answer>,
): Promise<Answer> {
  const lock = `${path}.lock`;
  const staged = `${path}.writing`;
  const mine = `${lock}.${process.pid}`;
  await writeFile(mine, JSON.stringify({ pid: process.pid, start: await startOf(process.pid) }));
  try {
    for (let waited = 0; ; waited += LOCK_POLL_MS) {
      try {
        await link(mine, lock);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (await abandoned(lock)) {
        await rm(staged, { force: true });
        await rm(lock, { force: true });
        continue;
      }
      if (waited >= LOCK_PATIENCE_MS) {
        throw new Error(
          `count budget could not write ${path}: another worker has held ${lock} for ${LOCK_PATIENCE_MS / 1000}s and is still running. If no run is writing ceilings, remove the file.`,
        );
      }
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  } finally {
    await rm(mine, { force: true });
  }
  try {
    return await write(staged);
  } finally {
    await rm(lock, { force: true });
  }
}

function writing(): boolean {
  const asked = (process.env[MODE] ?? "").trim();
  if (asked === "") return false;
  if (asked !== "write") {
    throw new Error(
      `${MODE} is ${JSON.stringify(asked)}, and the one value it takes is "write", which writes and lowers each test's ceilings instead of checking them; unset it, or leave it blank, to check`,
    );
  }
  if ((process.env["CI"] ?? "") !== "") {
    throw new Error(
      `${MODE}=write is refused under CI: the command lowers a file a person commits, a CI workspace throws it away, and a write skips the two checks CI is there for, a count below its ceiling and a file measured on another browser build. Run it on your own machine and commit the file.`,
    );
  }
  return true;
}

const WRITING = writing();

/** What the test's run owes, decided once it has finished: problems to fail it with, if any. */
async function verdict(
  measured: ReadonlyMap<string, Counts>,
  running: string,
  path: string,
  where: Where,
): Promise<string[]> {
  const shown = `${where.ceilings} › ${JSON.stringify(where.key)}`;
  if (WRITING) {
    return await locked(path, async (staged) => {
      const file = await ceilingsAt(path);
      const entry = entryIn(file, where.key, shown);
      if (entry !== undefined && isBroken(entry)) return [handEdited(where)];
      const next = lowered(entry, measured, running);
      await writeFile(
        staged,
        `${JSON.stringify(withEntry(file, where.key, next.entry), null, 2)}\n`,
      );
      await rename(staged, path);
      return next.changes
        .filter((change) => change.kind === "above")
        .map((change) => described(change, where));
    });
  }
  const entry = entryIn(await ceilingsAt(path), where.key, shown);
  if (entry !== undefined && isBroken(entry)) return [handEdited(where)];
  if (entry !== undefined && entry.browser !== running) {
    return [otherBrowser(entry.browser, running, where)];
  }
  return lowered(entry, measured, running).changes.map((change) => described(change, where));
}

/**
 * The invariant sweep's `test` with a `budget` fixture beside it. A test that
 * asks for `budget` marks its phases, and its counts are held to the ceilings
 * committed beside the spec. Annotated for the reason the sweep's own `test` is.
 * Each budgeted test carries its counts as the `count-budget` attachment, a JSON
 * object of `Counts` by phase.
 *
 * ```ts
 * import { test } from "@gokayo43/dev-config/count-budget";
 * ```
 */
export const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & InvariantSweep & CountBudget,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = swept.extend<CountBudget>({
  servedOrigins: [[], { option: true }],

  budget: async ({ page, browser, browserName, baseURL, servedOrigins }, provide, testInfo) => {
    if (testInfo.retry > 0) {
      throw new Error(
        `count budget refused «${keyOf(testInfo)}» on retry ${testInfo.retry}: counts are compared once, exactly, and a retry would pass a count that differs from one run to the next, which is the thing a budget exists to catch. Turn retries off for this spec with test.describe.configure({ retries: 0 }).`,
      );
    }
    const meter = await Meter.watching(page, originsOf(servedOrigins, baseURL));
    const measured = new Map<string, Counts>();
    const marked = new Set<string>();
    const unfinished: string[] = [];

    await provide({
      phase: async (name, action) => {
        if (marked.has(name)) {
          const twice = `count budget: this test already marked a phase named «${name}»; phase names are a test's keys into its ceilings, so each is used once`;
          unfinished.push(twice);
          throw new Error(twice);
        }
        marked.add(name);
        try {
          const start = await meter.still();
          const answer = await action();
          measured.set(name, phaseCounts(start, await meter.still()));
          return answer;
        } catch (error) {
          unfinished.push(
            `«${name}» did not finish: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      },
    });

    if (testInfo.status !== "passed") return;
    if (unfinished.length > 0) {
      throw new Error(
        [
          `count budget: «${keyOf(testInfo)}» went on after a phase failed, so its counts describe a job that did not happen:`,
          ...unfinished.map((each) => `  ${each}`),
        ].join("\n"),
      );
    }
    if (measured.size === 0) {
      throw new Error(
        `count budget: «${keyOf(testInfo)}» asked for \`budget\` and marked no phase; wrap the load and each interaction in budget.phase(name, action)`,
      );
    }
    meter.refusals();
    await testInfo.attach("count-budget", {
      body: JSON.stringify(Object.fromEntries(measured)),
      contentType: "application/json",
    });

    const where = {
      key: keyOf(testInfo),
      spec: relative(process.cwd(), testInfo.file),
      ceilings: relative(process.cwd(), ceilingsFor(testInfo.file)),
    };
    const problems = await verdict(
      measured,
      `${browserName} ${browser.version()}`,
      ceilingsFor(testInfo.file),
      where,
    );
    if (problems.length > 0) {
      throw new Error(
        [
          `count budget for «${where.key}» (${where.ceilings}), measured ${JSON.stringify(Object.fromEntries(measured))}:`,
          ...problems.map((problem) => `  ${problem}`),
        ].join("\n"),
      );
    }
  },
});
