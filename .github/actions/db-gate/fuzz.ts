import { EVERY_METHOD, type Route } from "../../../route-log.ts";
import type { Problem, Verdict } from "../_lib/gate.ts";
import { key } from "./route-table.ts";

/**
 * Generated junk at every route the booted app serves, and four invariants held
 * over what comes back.
 *
 * It is the third question this action asks of the same route table, and the
 * only one about *answers*. Route coverage asks whether the ramp reached a
 * route; the compatibility floor asks whether the repo still serves one; the
 * ramp itself sends the one request the scenario was written with, over and
 * over. None of them sends a request nobody expected — so an app whose every
 * handler assumes its path parameter parses passes all three and 500s on the
 * first crawler that walks past.
 *
 * What it is not is a security scanner. It sends no credentials and asserts
 * nothing about authorisation: what it grades is that a hostile input is
 * *refused* rather than crashed on, which is a floor in the sense the coverage
 * threshold is one — an app that passes has not been shown to be safe, and an
 * app that fails has a handler nobody bounded.
 *
 * ## Where it runs, and why it is last
 *
 * **After the ramp has taken its second route-log snapshot.** Coverage is the
 * difference between two snapshots, so once the second is on disk nothing sent
 * here can reach it — but a fuzz step ordered before that capture would put
 * this step's traffic inside it, and a route the ramp never touched would clear
 * the floor on a request that was never a scenario's. The step order in
 * `action.yml` is the whole of that guarantee and `tests/action-evidence.test.ts`
 * holds it; the floor reading the snapshots later changes nothing either way.
 *
 * ## Determinism
 *
 * One seed per run, printed in the summary, and every request derived from it:
 * the nth request to a route is a pure function of the seed, the route's name
 * and n, so nothing about *when* a request was sent decides *what* was sent. A
 * failure therefore replays from the seed alone — the same seed sends the same
 * requests in the same order — which is what makes a fuzzer's failure a bug
 * report rather than an anecdote.
 *
 * The generator draws printable, single-line values and nothing else, and every
 * hostile byte that is not printable arrives percent-encoded in a URL or
 * `\\u`-escaped inside JSON. That is not squeamishness about control characters:
 * a failure is reported as a `curl` command, and a command a reader cannot
 * paste is a failure they have to reproduce by hand. `tests/fuzz.test.ts` runs
 * one of those commands per class against a real server and compares what
 * arrived with what the fuzzer sent, because a replay command nobody has
 * executed is a string that looks like one.
 */

/**
 * What every run gets, and what a nightly gets, as wall clock rather than a
 * request count: a request count is a different amount of work on every app and
 * on every runner, and what this step must not do is decide how long a job
 * takes. Twenty seconds is the largest number that disappears into a job that
 * has already replayed a schema and ramped an app; ten minutes is what the
 * nightly has, and is the difference between brushing each route and searching
 * it.
 *
 * There is no input for either, the way there is none for the ramp: an app the
 * database job can boot is an app that answers, and a repo cannot be in the
 * position of having this available and switched off.
 */
const SHORT_BUDGET_MS = 20_000;
const LONG_BUDGET_MS = 600_000;

/**
 * Which of the two this run gets. A spelling this does not know is refused
 * rather than read as "not nightly": the nightly is the run nobody watches, and
 * a typo there is a long budget that silently never happened — the failure mode
 * check.yml's own input guards exist to prevent, one layer down.
 */
export function budgetFor(nightly: string): number {
  if (nightly !== "true" && nightly !== "false") {
    throw new Error(
      `nightly is "${nightly}" — it takes true or false, and nothing else can be read as either`,
    );
  }
  return nightly === "true" ? LONG_BUDGET_MS : SHORT_BUDGET_MS;
}

/** The largest seed there is, which is the state mulberry32 holds. */
const SEEDS = 2 ** 32;

/**
 * The run's seed: the caller's where it named one, and otherwise the run's own
 * id hashed into the range.
 *
 * Derived rather than random, because the point of the seed is that a failure
 * can be sent again — a value nothing recorded would be reported in the summary
 * of a run whose logs expire, and re-running the same commit would fuzz
 * something else. Derived from the *run* rather than the commit so that a
 * re-run searches somewhere new: a green run says this seed found nothing, not
 * that there is nothing to find.
 */
export function seedFrom(value: string, runId: string): number {
  const written = value.trim();
  if (written === "") return hashOf(runId);
  if (!WHOLE.test(written) || Number(written) >= SEEDS) {
    throw new Error(
      `fuzz-seed is "${value}" — it takes a whole number below ${SEEDS}, which is the seed a failing run prints for you to paste back`,
    );
  }
  return Number(written);
}

/** A whole number and nothing else: no sign, no exponent, no decimal point. */
const WHOLE = /^\d+$/u;

/**
 * How long one request has to be answered in. A bound rather than the job's
 * timeout, because "the app stopped answering" is the finding here and a step
 * that hangs reports nothing at all — the same argument the boot poll's
 * `--max-time` and the probe's bound both make.
 */
export const RESPONSE_BOUND_MS = 10_000;

/**
 * How many failures are printed in full — in the log and as annotations. The
 * artifact carries every one of them: an annotation per failure is a step
 * nobody can read, and a run that only *kept* what it printed would answer "how
 * bad is it" with the size of its own cap.
 */
const MOST_PRINTED = 25;

/**
 * How many failures end the run. Not a display bound but a real one: an app
 * that falls over on one hostile input usually falls over on the rest, and at
 * four thousand requests a second the difference between stopping here and
 * spending the whole budget is a report of a thousand copies of one bug — and,
 * on the long budget, gigabytes of them held in memory on the way to the
 * artifact. The run says it stopped, so the number is never read as "and no
 * more than these".
 */
const ENOUGH_FAILURES = 1_000;

/** How much of a response body a failure carries: enough to see what answered, short enough to read. */
const BODY_SHOWN = 500;

/** A number in [0, 1), as a stream of them. */
type Random = () => number;

/**
 * mulberry32: thirty lines of arithmetic with a 32-bit state, which is the
 * whole reason it is here rather than a package. An action runs from a checkout
 * with no install, so a generator with a dependency is a generator this step
 * cannot have — and what is wanted of it is reproducibility, not statistical
 * quality.
 */
function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a over the text, which is how a route's name and a request's position become one seed. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * One of these, drawn from the stream.
 *
 * The index is in range by construction — `random()` is below 1 and the tuple is
 * non-empty — so `?? values[0]` is not a fallback for anything: it is what
 * `noUncheckedIndexedAccess` asks for, and the first element is the one value
 * known to exist. No table below holds a nullish member, which is what keeps it
 * from being a fallback in fact: a member that was `undefined` would be silently
 * replaced by the first, and the class would never be drawn at all.
 */
function pick<T>(random: Random, values: readonly [T, ...T[]]): T {
  return values[Math.floor(random() * values.length)] ?? values[0];
}

/** A repetition, for the two classes whose point is that they are too big. */
function long(character: string, bytes: number): string {
  return character.repeat(bytes);
}

/**
 * The classes a path parameter is drawn from. Classes rather than a list of
 * values: what a handler gets wrong is a *kind* of input — a number it did not
 * bound, an encoding it decoded twice, a length it did not cap — and a list is
 * that kind with the members somebody happened to think of frozen into it.
 *
 * Each is one line of what the app is being asked to survive, and the name
 * travels into the failure so a reader is told which kind broke it.
 */
const PARAMETERS: readonly [Class, ...Class[]] = [
  {
    named: "a number at a boundary",
    // Zero and the negative are what an unchecked `- 1` walks off; 2147483648
    // is one past a 32-bit column; 2^53 and one below its negative are where a
    // double stops counting and a bigint column does not; 1e309 is the decimal
    // that parses to Infinity.
    draw: (random) =>
      pick(random, ["0", "-1", "2147483648", "9007199254740992", "-9007199254740993", "1e309"]),
  },
  { named: "nothing at all", draw: () => "" },
  {
    named: "text outside ASCII",
    draw: (random) => pick(random, ["é", "👻", "İ", "ß".repeat(64), "〇"]),
  },
  {
    named: "a path walked upwards",
    draw: (random) => pick(random, ["../../etc/passwd", "/etc/passwd", "....//....//etc/passwd"]),
  },
  {
    // Already escaped when it arrives, so the value the app decodes is one level
    // in from the value it was sent: the class that catches a handler decoding
    // twice, which is how a walked path survives a check that looked at the
    // encoded form.
    named: "an escape the app may decode twice",
    draw: (random) => pick(random, ["%2e%2e%2f", "%252e%252e%252f", "%00", "%zz", "%"]),
  },
  {
    named: "a string that means something to a parser",
    draw: (random) =>
      pick(random, [
        "'",
        '"',
        "' OR 1=1 --",
        "$ne",
        "{}",
        '{"$gt":""}',
        "${7*7}",
        "{{7*7}}",
        "`id`",
        "%s",
        "*",
      ]),
  },
  { named: "far more text than anything expects", draw: () => long("a", 4_096) },
];

/** What is asked of a generator class: a name for the failure, and a value from the stream. */
interface Class {
  readonly named: string;
  readonly draw: (random: Random) => string;
}

/**
 * The classes a query string is drawn from. A query is where a framework's own
 * parser sits — the one piece of request handling almost nobody in an app
 * writes — so what these ask about is mostly that parser: what it does with a
 * key it sees twice, with a shape it half-supports, and with a value nobody
 * capped.
 */
const QUERIES: readonly [Class, ...Class[]] = [
  { named: "no query at all", draw: () => "" },
  {
    named: "a key nothing declared",
    draw: (random) =>
      `${pick(random, ["q", "filter", "x-y", "0", "__proto__"])}=${pick(random, ["1", "true", "null", "-"])}`,
  },
  { named: "one key given several times", draw: () => "id=1&id=2&id=3" },
  { named: "a value nobody capped", draw: () => `q=${long("a", 4_096)}` },
  {
    named: "a key shaped like a structure",
    draw: (random) => pick(random, ["a[]=1&a[]=2", "a.b=1", "a[b][c]=1", "a[0]=1&a[1]=2"]),
  },
  { named: "a key with no value", draw: () => "flag" },
  { named: "an escape that is not one", draw: () => "q=%zz&r=%" },
];

/**
 * The content types a request carries. Every value is ASCII: a header value
 * outside it is refused by `fetch` before anything is sent, so a generator that
 * drew one would be fuzzing this step rather than the app.
 *
 * `header: null` is a class like any other — the request that carries no
 * content type at all, which is what a client written against a different route
 * sends. It is `null` and named rather than a hole in the table: a member that
 * was `undefined` would be swallowed by `pick` above and the class would never
 * be drawn, which is exactly what happened while this was a bare list.
 */
const CONTENT_TYPES: readonly [ContentType, ...ContentType[]] = [
  { named: "sent as JSON", header: "application/json" },
  { named: "sent as a form", header: "application/x-www-form-urlencoded" },
  { named: "sent as text", header: "text/plain" },
  { named: "sent with no content type", header: null },
  { named: "sent as a type that is not one", header: "banana/soup" },
];

interface ContentType {
  readonly named: string;
  /** The header value, or nothing where the class is that there is no header. */
  readonly header: string | null;
}

/**
 * The classes a body is drawn from, for the methods that take one. `writes` is
 * how a shell produces the body where the bytes cannot be an argument at all —
 * the megabyte, and only it. A class that grows past what an annotation can
 * carry and does not add one fails `tests/fuzz.test.ts`, which is where that
 * bound is: a length checked here would be a silent fallback to printing the
 * megabyte, and the point of the field is that there is nothing to fall back to.
 */
const BODIES: readonly [Body, ...Body[]] = [
  { named: "JSON that stops half way", text: '{"a":' },
  { named: "a JSON literal where an object was expected", text: "null" },
  { named: "a list where an object was expected", text: "[]" },
  { named: "a hundred nested objects", text: nested(100) },
  {
    named: "a megabyte of one character",
    text: `"${long("a", 1_048_576)}"`,
    // Piped rather than substituted into an argument. Linux caps a single argv
    // string at 128 KiB (MAX_ARG_STRLEN), so a megabyte expanded into one is
    // `Argument list too long` before curl starts — the printed command failed
    // for every draw of this class until it was written this way.
    writes: `printf '"'; head -c 1048576 /dev/zero | tr '\\0' a; printf '"'`,
  },
  {
    named: "every field the wrong type",
    text: '{"id":[],"name":123,"ok":"maybe","at":{"$date":0}}',
  },
  {
    // Printable on the wire and hostile once parsed, which is the only way this
    // fuzzer sends a control character at all: a NUL a driver truncates on, an
    // escape sequence a log viewer obeys, and a lone surrogate that cannot be
    // re-encoded to UTF-8 at whatever boundary the value is written out at.
    named: "escapes a parser turns back into control characters",
    text: '{"a":"\\u0000\\u001b[31m\\r\\n","b":"\\ud800"}',
  },
  { named: "an empty body", text: "" },
];

interface Body {
  readonly named: string;
  readonly text: string;
  /** A command writing it to stdout, where the bytes cannot be an argument. */
  readonly writes?: string;
}

/** `{"a":{"a":…}}`, deep enough that a recursive parser or validator has to have a bound. */
function nested(depth: number): string {
  return `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
}

/** What a route registered for every method is asked with. */
const METHODS: readonly [string, ...string[]] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** The methods `fetch` refuses to attach a body to, which is the runtime's rule and not this gate's. */
const BODILESS = new Set(["GET", "HEAD"]);

/** One request, as everything needed to send it, report it and run it again by hand. */
export interface Attempt {
  readonly method: string;
  /** The route as its router registered it, which is what the report names. */
  readonly path: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Body | undefined;
  /** The classes this request was drawn from, for a reader deciding what broke. */
  readonly drawn: string[];
}

/**
 * The nth request to a route under a seed — a pure function of the three, which
 * is the whole of what "replays from the seed" means. Nothing here reads a
 * clock, a counter or another route's stream, so the request a failure names is
 * the request that seed produces however the run was scheduled.
 */
export function attemptFor(origin: string, route: Route, seed: number, index: number): Attempt {
  const random = mulberry32(hashOf(`${seed}:${key(route)}:${index}`));
  const method =
    route.method.toUpperCase() === EVERY_METHOD
      ? pick(random, METHODS)
      : route.method.toUpperCase();

  const drawn: string[] = [];
  // Percent-encoded, every one of them. A URL is parsed before it is sent, so a
  // raw `../` is resolved away by the parser and the app is asked about a path
  // nobody generated — the encoded form is the one that survives to the
  // handler, and decoding it is the app's business, which is the point.
  const path = route.path.replaceAll(/:[^/]+|\*/gu, () => {
    const parameter = pick(random, PARAMETERS);
    drawn.push(parameter.named);
    return encodeURIComponent(parameter.draw(random));
  });

  const query = pick(random, QUERIES);
  drawn.push(query.named);
  const drawnQuery = query.draw(random);

  const type = pick(random, CONTENT_TYPES);
  drawn.push(type.named);

  const body = BODILESS.has(method) ? undefined : pick(random, BODIES);
  if (body !== undefined) drawn.push(body.named);

  return {
    method,
    path: route.path,
    url: `${origin}${path}${drawnQuery === "" ? "" : `?${drawnQuery}`}`,
    headers: type.header === null ? {} : { "content-type": type.header },
    body,
    drawn,
  };
}

/** A shell word, in the one quoting that has no escapes inside it. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The request again, as a command. It is the whole of what a failure hands
 * back: a reader who cannot re-send the request is reading a story about one,
 * so `tests/fuzz.test.ts` runs one of these per class and compares what the
 * server received with what the fuzzer sent.
 *
 * Three things here are curl's rather than the request's, and each was a
 * command that did not run:
 *
 * - `-g` turns off URL globbing. Without it every generated `a[b][c]=1` is a
 *   "bad range in URL" and the command never leaves the shell — and a query
 *   shaped like a structure is one of the classes above.
 * - a body over 128 KiB goes in on stdin, because that is where Linux caps a
 *   single argv string.
 * - a request that carried no content type says so with an empty `-H`, since
 *   curl adds `application/x-www-form-urlencoded` to any `--data` of its own
 *   accord and the replay would then not be the request that failed.
 */
export function curlFor({ method, url, headers, body }: Attempt): string {
  const sent = Object.entries(headers).flatMap(([name, value]) => [
    "-H",
    quoted(`${name}: ${value}`),
  ]);
  const suppressed =
    body !== undefined && headers["content-type"] === undefined
      ? ["-H", quoted("content-type:")]
      : [];
  const command = ["curl", "-g", "-i", "-X", method, ...sent, ...suppressed, quoted(url)];
  if (body === undefined) return command.join(" ");
  if (body.writes === undefined) {
    return [...command, "--data-raw", quoted(body.text)].join(" ");
  }
  return `{ ${body.writes}; } | ${[...command, "--data-binary", "@-"].join(" ")}`;
}

/**
 * One request the app answered wrongly, or did not answer. Not exported: the
 * report is what leaves this module, and every reader of a failure — the log,
 * the annotation, the artifact — is written here.
 */
interface Failure {
  readonly method: string;
  readonly path: string;
  readonly curl: string;
  /** Absent where nothing answered at all. */
  readonly status?: number;
  /** The first bytes of what came back, or what went wrong instead. */
  readonly body: string;
  /** Which invariant this broke, in the words the report uses. */
  readonly broke: string;
  readonly drawn: string[];
}

/** Everything the run established, which is both what is published and what the artifact holds. */
export interface Fuzzed {
  readonly seed: number;
  readonly budgetMs: number;
  /** How many routes were fuzzed, which is the table less whatever the ramp waived. */
  readonly routes: number;
  readonly waived: number;
  readonly requests: number;
  /** Whether the run ended on `ENOUGH_FAILURES` rather than on its budget. */
  readonly stopped: boolean;
  /** Every failure the run found, which is what the artifact carries. */
  readonly failures: Failure[];
}

/** What the app is fuzzed with, and for how long. */
export interface Plan {
  /** Scheme, host and port of the booted app: every request is this plus a route. */
  readonly origin: string;
  readonly routes: readonly Route[];
  /**
   * The routes the ramp was told not to reach, by `key`. A repo writes them in
   * `route-allowlist` and says why in the same line, and a route that is
   * destructive, credentialed or reaches something outside this box is not one
   * to send generated `DELETE`s at either — so the ramp's exemption is this
   * step's exemption, read from the same input rather than from a second one
   * nobody would keep in step.
   */
  readonly waived: ReadonlySet<string>;
  readonly seed: number;
  readonly budgetMs: number;
  /** How long one request gets, `RESPONSE_BOUND_MS` in a run and shorter in this gate's own suite. */
  readonly boundMs: number;
}

/**
 * A stack frame, which is the whole of what "leaked a stack trace" is read as:
 * an indented `at`, and after it a path whose file carries a line number —
 * `at handler (/srv/app/things.ts:41:19)` and `at /srv/app/things.ts:41:19`
 * alike.
 *
 * Nothing looser. This was `Error:` beside anything that looked like a
 * filename, and that is a correct refusal in almost every API: a 400 answering
 * `{"error":"Error: id must be a positive integer — see openapi.json"}` was
 * read as a leaked trace on every request, because `Error:` occurs in prose and
 * `package.json` contains `package.js`. The extension ends on a word boundary
 * and the line number is required, which is what a frame has and a sentence
 * does not.
 */
const FRAME = /\n\s+at\s[^\n]*[/\\][\w.-]+\.[cm]?[jt]sx?\b:\d+/u;

/**
 * The four invariants by name, stated once: each check below opens its
 * diagnostic with the one it broke, and `docs/gates/fuzz.md` is held to this
 * list by `tests/fuzz.test.ts`. A page that documents a floor the module does
 * not hold is worse than no page.
 */
const BELOW_500 = "the status is below 500";
const NO_TRACE = "no stack trace in the body";
const JSON_PARSES = "a JSON content type parses";
const ANSWERED = "the answer arrives inside the bound";

export const INVARIANTS: readonly string[] = [BELOW_500, NO_TRACE, JSON_PARSES, ANSWERED];

/**
 * Every class a request is drawn from, by the table it belongs to — for the
 * same page and the same test. The keys are the words the page's first column
 * uses, since a reader matching a row to a table is what they are for.
 */
export const CLASSES = {
  "path parameter": PARAMETERS.map(({ named }) => named),
  "query string": QUERIES.map(({ named }) => named),
  "content type": CONTENT_TYPES.map(({ named }) => named),
  body: BODIES.map(({ named }) => named),
} satisfies Record<string, readonly string[]>;

/** The statuses that carry no body, so an empty one under a JSON content type is the protocol rather than a fault. */
const BODILESS_STATUS = new Set([204, 205, 304]);

/** Whether the header claims JSON, in either of the two spellings that mean it. */
function claimsJson(type: string | null): boolean {
  const written = (type ?? "").toLowerCase();
  return written.startsWith("application/json") || written.includes("+json");
}

/**
 * Which invariant the answer broke, or nothing. Four, and each is a statement
 * about the app rather than about the request: a request nobody expected is
 * exactly what a 4xx is for, so the fault is never that the app said no.
 */
function brokenBy(answered: Response, text: string): string | undefined {
  if (answered.status >= 500) {
    return `${BELOW_500}: answered ${answered.status} — a request nobody expected is a 4xx, and a 5xx is the handler falling over`;
  }
  if (FRAME.test(text)) {
    return `${NO_TRACE}: an internal path and a line number are what an attacker reads first, and a caller can do nothing with either`;
  }
  if (claimsJson(answered.headers.get("content-type")) && !BODILESS_STATUS.has(answered.status)) {
    try {
      JSON.parse(text);
    } catch {
      return `${JSON_PARSES}: answered application/json with a body that is not JSON, and every client of this route parses what it is told the type of`;
    }
  }
  return undefined;
}

/**
 * The attempt as `fetch` takes it. Exported because the suite sends one and then
 * runs its printed `curl` against the same server: the two have to be one
 * request, and a second spelling of this in the suite is the drift that would
 * hide.
 */
export function requestFor(sending: Attempt, boundMs: number): RequestInit {
  return {
    method: sending.method,
    headers: sending.headers,
    ...(sending.body === undefined ? {} : { body: sending.body.text }),
    // Nothing is carried between requests and nothing authenticates one: what
    // this grades is the handler in front of the door, not what is behind it.
    redirect: "manual",
    signal: AbortSignal.timeout(boundMs),
  };
}

/** What the app said, or what happened instead of it answering. */
async function attempt(sending: Attempt, boundMs: number): Promise<Failure | undefined> {
  /** The one place a failure is built, so its two paths cannot describe one differently. */
  const failed = (broke: string, body: string, status?: number): Failure => ({
    method: sending.method,
    path: sending.path,
    curl: curlFor(sending),
    ...(status === undefined ? {} : { status }),
    body: body.slice(0, BODY_SHOWN),
    broke,
    drawn: sending.drawn,
  });

  let answered: Response;
  let text: string;
  try {
    answered = await fetch(sending.url, requestFor(sending, boundMs));
    text = await answered.text();
  } catch (error) {
    // The one place a network failure is the finding rather than an accident:
    // the app is a local process this job started, so a refused connection or a
    // request that ran out of time is the app having stopped answering.
    return failed(
      `${ANSWERED}: nothing arrived within ${boundMs}ms, or the app stopped answering altogether — every later request in this run is measuring the same failure`,
      error instanceof Error ? error.message : String(error),
    );
  }

  const broke = brokenBy(answered, text);
  return broke === undefined ? undefined : failed(broke, text, answered.status);
}

/**
 * The run: round-robin over the routes, one request at a time, until the budget
 * is spent.
 *
 * Round-robin rather than route by route, so that a budget that runs out has
 * still asked every route the same number of questions — a slow route otherwise
 * spends the whole budget and every route after it in the table is never fuzzed
 * at all, which is a floor that silently covers the first half of an app.
 *
 * Sequential rather than concurrent, because this is not a load generator: the
 * ramp before it is the step that measures what the app holds, and requests in
 * flight together would make "the app stopped answering" ambiguous about which
 * request did it.
 */
export async function fuzz({
  origin,
  routes,
  waived,
  seed,
  budgetMs,
  boundMs,
}: Plan): Promise<Fuzzed> {
  const fuzzing = routes.filter((route) => !waived.has(key(route)));
  const answer = (requests: number, failures: Failure[], stopped: boolean): Fuzzed => ({
    seed,
    budgetMs,
    routes: fuzzing.length,
    waived: routes.length - fuzzing.length,
    requests,
    stopped,
    failures,
  });

  // Nothing to send, which is a repo that has waived every route it serves and
  // said why against each — the coverage floor has already read those same
  // reasons. An empty table is that floor's failure one step earlier and never
  // reaches here.
  if (fuzzing.length === 0) return answer(0, [], false);

  const deadline = Date.now() + budgetMs;
  const failures: Failure[] = [];
  let requests = 0;

  for (let index = 0; Date.now() < deadline; index++) {
    for (const route of fuzzing) {
      if (Date.now() >= deadline) break;
      requests++;
      const failure = await attempt(attemptFor(origin, route, seed, index), boundMs);
      if (failure === undefined) continue;
      failures.push(failure);
      if (failures.length >= ENOUGH_FAILURES) return answer(requests, failures, true);
    }
  }

  return answer(requests, failures, false);
}

/**
 * One failure as the lines a reader needs: what broke, what it was drawn from,
 * the command that sends it again, and the first of what came back. On the log
 * rather than in the annotation, because the annotation is one line and this is
 * five — and because a body is the app's own text, which the annotation would
 * have to escape into something nobody can read.
 */
function statedIn(failure: Failure): string {
  return [
    `${failure.method} ${failure.path} ${failure.broke}`,
    `  drawn from: ${failure.drawn.join("; ")}`,
    `  replay:     ${failure.curl}`,
    `  answered:   ${failure.status === undefined ? "nothing" : String(failure.status)}`,
    `  body:       ${failure.body}`,
  ].join("\n");
}

/**
 * What the step publishes and what it fails on. The seed is in the table
 * whichever way the run went: a green run's seed is the one a reader reruns
 * with when the app changes, and a red run's is the only thing that reproduces
 * it.
 */
export function fuzzVerdict(fuzzed: Fuzzed): Verdict {
  const printed = fuzzed.failures.slice(0, MOST_PRINTED);
  const table = [
    "### Fuzz",
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    `| Routes fuzzed | ${fuzzed.routes} |`,
    `| Routes waived by route-allowlist | ${fuzzed.waived} |`,
    `| Requests | ${fuzzed.requests} |`,
    `| Failures | ${fuzzed.failures.length} |`,
    `| Seed | ${fuzzed.seed} |`,
    `| Budget | ${fuzzed.budgetMs / 1000}s |`,
    "",
    `Every request is a pure function of the seed, the route and its position, so \`fuzz-seed: ${fuzzed.seed}\` sends this run again.`,
    "",
  ].join("\n");

  const problems: Problem[] = printed.map((failure) => ({
    message: `${failure.method} ${failure.path} ${failure.broke} — replay it with: ${failure.curl}`,
  }));
  if (fuzzed.failures.length > printed.length) {
    problems.push({
      message: `${fuzzed.failures.length} requests broke an invariant and the first ${printed.length} are above — the rest are in the fuzz report this step uploads, and fixing these first is usually fixing all of them`,
    });
  }
  if (fuzzed.stopped) {
    problems.push({
      message: `the run stopped at ${fuzzed.failures.length} failures rather than at its budget — an app failing this often is one to fix before measuring again, and the run past this point is copies of what is already above`,
    });
  }

  return {
    note: `fuzz: ${fuzzed.requests} generated requests over ${fuzzed.routes} routes, ${fuzzed.failures.length} failures, seed ${fuzzed.seed}`,
    table,
    ...(printed.length === 0
      ? {}
      : { log: printed.map((failure) => statedIn(failure)).join("\n") }),
    problems,
  };
}
