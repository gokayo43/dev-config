# The route fuzzer

The last step of `database: postgres`: generated junk at every route the booted
app serves, with four invariants held over what comes back. Zero lines in the
consuming repo — the route table the app already declares for the ramp is the
whole of what it needs.

## What it is for

An app gets three kinds of request in CI, and they are all requests somebody
meant. The boot gate polls the health route; the repo's own probe asserts what
the repo knows; the ramp sends the scenario's request over and over. So a
handler that assumes its path parameter parses, or that returns its own
exception to the caller, passes every gate here and falls over on the first
crawler that walks past.

**It is not a security scanner.** It sends no credentials and asserts nothing
about authorisation. What it grades is that a hostile input is _refused_ rather
than crashed on — a floor in the sense [the route coverage floor](capacity.md)
is one. An app that passes has not been shown to be safe; an app that fails has
a handler nobody bounded.

The boot is unsealed, exactly as the ramp leaves it: the app the fuzzer talks to
is the one the database job started, on the same port, with the same
environment. Nothing here changes that.

## The four invariants

Each is a statement about the answer, and each is a failure that fails the job.
A failing request opens its diagnostic with the name of the one it broke, and
the names here are held to `db-gate/fuzz.ts`'s own list by
`tests/fuzz.test.ts` — a page documenting a floor the module does not hold is
worse than no page.

| Invariant                           | Why it is the app's fault and not the request's                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| the status is below 500             | A request nobody expected is what a 4xx is for. A 5xx is the handler falling over, and the fuzzer says nothing at all about an app that refuses junk. |
| no stack trace in the body          | An internal path and a line number are what an attacker reads first, and a caller can do nothing with either.                                         |
| a JSON content type parses          | Every client of a route parses what it is told the type of; a body that is not what the header claims breaks all of them at once.                     |
| the answer arrives inside the bound | "The app stopped answering" is the finding, and a step with no bound reports it by spending the job's whole timeout. Ten seconds, per request.        |

A `204`, `205` or `304` under a JSON content type is not held to the parsing
rule: those statuses carry no body, and an empty one there is the protocol
rather than a fault.

**A stack trace is a frame line** — an indented `at`, and after it a path whose
file carries a line number — and deliberately nothing looser. The first version
of this read `Error:` beside anything shaped like a filename, which is a correct
refusal in almost every API: a 400 answering
`{"error":"Error: id must be a positive integer — see openapi.json"}` was graded
as a leak on every request, because `Error:` occurs in prose and `package.json`
contains `package.js`.

## What it sends

Per route, per request: a value for every path parameter, a query string, a
content type, and — for the methods that can carry one — a body. Each is drawn
from a table of **classes** rather than a list of values, because what a handler
gets wrong is a kind of input, and a list is that kind with the members somebody
happened to think of frozen into it. The class that produced a value travels
into the failure, so a reader is told which kind broke the route.

| Where          | Class                                               | What it is about                                                                                                                   |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| path parameter | a number at a boundary                              | zero and the negative an unchecked `- 1` walks off, one past a 32-bit column, past a double, and a decimal that parses to Infinity |
| path parameter | nothing at all                                      | the segment that is there and empty                                                                                                |
| path parameter | text outside ASCII                                  | a name a byte-length check reads as shorter than it is                                                                             |
| path parameter | a path walked upwards                               | the traversal, arriving percent-encoded so the app's own decode is what is under test                                              |
| path parameter | an escape the app may decode twice                  | a value already escaped when it arrives, which is how a walked path survives a check that looked at the encoded form               |
| path parameter | a string that means something to a parser           | quotes, SQL, `$`, `{}`, a template expression, a backtick                                                                          |
| path parameter | far more text than anything expects                 | four kilobytes where an identifier was expected                                                                                    |
| query string   | no query at all                                     | the request a handler reading `?page` was never sent                                                                               |
| query string   | a key nothing declared                              | including `__proto__`, which some parsers assign through                                                                           |
| query string   | one key given several times                         | the shape almost nobody's parser agrees about                                                                                      |
| query string   | a value nobody capped                               | four kilobytes in one parameter                                                                                                    |
| query string   | a key shaped like a structure                       | `a[]`, `a.b`, `a[b][c]`, `a[0]` — the half-supported forms                                                                         |
| query string   | a key with no value                                 | `?flag`, which is a string to one parser and a boolean to another                                                                  |
| query string   | an escape that is not one                           | `%zz` and a bare `%`                                                                                                               |
| content type   | sent as JSON                                        | the type the route expects, with a body it does not                                                                                |
| content type   | sent as a form                                      | a body parsed by the other branch                                                                                                  |
| content type   | sent as text                                        | a body nothing will parse                                                                                                          |
| content type   | sent with no content type                           | what a client written against a different route sends                                                                              |
| content type   | sent as a type that is not one                      | a type no branch matches                                                                                                           |
| body           | JSON that stops half way                            | the parse error every handler has to answer for                                                                                    |
| body           | a JSON literal where an object was expected         | `null`                                                                                                                             |
| body           | a list where an object was expected                 | `[]`                                                                                                                               |
| body           | a hundred nested objects                            | the depth a recursive validator has to bound                                                                                       |
| body           | a megabyte of one character                         | the payload limit, and whether there is one                                                                                        |
| body           | every field the wrong type                          | a list where a number goes, a number where a string goes                                                                           |
| body           | escapes a parser turns back into control characters | a NUL a driver truncates on, an escape sequence a log viewer obeys, a lone surrogate that cannot be re-encoded                     |
| body           | an empty body                                       | the required body that is not there                                                                                                |

The names in the second column are `db-gate/fuzz.ts`'s own, and
`tests/fuzz.test.ts` holds this table to them by set equality: a class with no
row is one a reader never hears of, and a row with no class is advice about a
request nothing sends.

A route registered for every method (`ALL`) is asked with a method the run
picks, since that is a handler nobody has ever sent a `DELETE` to. A route that
registered one method is asked with that one: anything else measures the
router's 405.

Every path parameter is **percent-encoded**. A URL is parsed before it is sent,
so a raw `../` is resolved away by the parser and the app is asked about a path
nobody generated; the encoded form is what survives to the handler, and decoding
it is the app's business, which is the point.

Every generated byte is printable and on one line. That is not squeamishness
about control characters: a failure is reported as a `curl` command, and a
command a reader cannot paste is a failure they have to reproduce by hand.

**The printed command is executed by this gate's own suite** — one per class,
against a real server, with what arrived compared to what the fuzzer sent. It is
tested that way because it did not work: 56 of 300 printed commands did not run
at all, the megabyte body having been expanded into a single argv string past
the 128 KiB Linux allows one, and every query shaped like a structure having
been read by curl as a glob. So the command carries `-g`, a body too big to be
an argument arrives on stdin, and a request that carried no content type says so
with an empty `-H` rather than letting curl add one of its own.

**A body on a GET is not among them.** `fetch` refuses to construct one — the
runtime's rule, not this gate's — so sending that request needs a raw socket,
and the run would otherwise die on its own request rather than on the app's
answer. dev-config#114 is where that is tracked.

## What it does not send

**The routes `route-allowlist` names.** The ramp's exemption is this step's
exemption, read from the same input rather than from a second one nobody would
keep in step: the reason a repo wrote there is about the route — it is
destructive, it needs a credential, it reaches something off this box — and
every one of those is a reason not to send generated `DELETE`s at it either. The
entries are graded by [the coverage floor](capacity.md), which has already run;
this reads them. The summary says how many routes were waived, so a table
covering less than the app serves says so.

## The seed

One seed per run, printed in the summary and in the table, and every request
derived from it: the nth request to a route is a pure function of the seed, the
route's name and n. Nothing about _when_ a request was sent decides _what_ was
sent, so a failure replays from the seed alone.

Unset, the seed comes from the run's own id — derived rather than random,
because a value nothing recorded would be printed in the summary of a run whose
logs expire. From the _run_ rather than from the commit, so that a re-run
searches somewhere new: a green run says this seed found nothing, not that there
is nothing to find.

To send a run again, paste the number it printed:

```yaml
with:
  database: postgres
  fuzz-seed: "2751418394"
```

Per-route streams, so adding a route to an app does not change what every other
route is asked — which is what makes a seed from last week worth pasting into
this week's run.

## The budget

Twenty seconds on every run, ten minutes under `nightly`, as wall clock rather
than a request count: a count is a different amount of work on every app and on
every runner, and what this step must not do is decide how long a job takes.

**There is no knob**, for the reason [the ramp has none](capacity.md): an app the
database job can boot is an app that answers, and a repo cannot be in the
position of having this available and switched off. The two numbers are in
`db-gate/fuzz.ts`.

The budget is read before each request rather than during one, so a step can
overrun it by up to the ten-second response bound — the request in flight when
the budget runs out still has its own bound to spend.

A run also ends early at a thousand failures, which is not a display bound: an
app that falls over on one hostile input usually falls over on the rest, and the
difference between stopping there and spending ten nightly minutes is a report
of a thousand copies of one bug. The run says it stopped, so the number is never
read as "and no more than these".

Round-robin over the routes rather than route by route, so a budget that runs
out has still asked every route the same number of questions — a slow route
would otherwise spend the whole budget and every route below it in the table
would never be fuzzed at all. Sequential rather than concurrent: this is not a
load generator, the ramp before it is the step that measures what the app holds,
and requests in flight together would make "the app stopped answering"
ambiguous about which request did it.

## Why it runs last

**After the ramp has taken its second route-log snapshot.** That is the whole of
the constraint, and it is about the capture rather than about
[the floor](capacity.md) that later reads it: coverage is the difference between
two snapshots on disk, so once the second exists nothing sent here can reach it,
whenever the floor gets round to reading them.

What a fuzz step ordered _before_ that capture would change is which traffic the
second snapshot carried: every route would be credited with this step's
requests, and a route the ramp never touched would clear the floor on a request
that was never a scenario's. The step order in `db-gate/action.yml` is the whole
of that guarantee, and `tests/action-evidence.test.ts` is what holds it — a
suite driving the module cannot, since both readings of the floor are pure
functions of two files nothing here writes.

It also reads the route table out of that same snapshot rather than fetching the
app's endpoint again: one read, so the routes fuzzed cannot be a different set
from the routes held to the floor.

## What is published

The run summary gets a table — routes, requests, failures, seed, budget — and
the first twenty-five failures reach the log in full: what broke, the classes
the request was drawn from, the `curl` that sends it again, and the first 500
bytes of what came back. Each of them is an annotation as well, so the failure
is on the step rather than only in its output.

A run with more failures than it prints says how many there were. The two
numbers differ on purpose: an app broken everywhere produces thousands, a step
annotating all of them would report nothing readable, and a step counting only
what it printed would say the app has twenty-five problems.

Everything the run saw is in `fuzz.json`, inside the `db-gate-evidence`
artifact — every failure it found, not the twenty-five it printed — and it is
what the nightly reads the seed and the first failure out of when it files an
issue.
