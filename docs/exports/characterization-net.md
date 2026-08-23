# The characterization net

`@gokayo43/dev-config/characterization-net.ts` is the harness under a golden —
characterization — suite: `assertNet` and `rebaselineNet`, over a `Net` the repo
declares.

The testing canon already asks for golden oracles built from real captured
payloads. This is the layer under that. At a few thousand fixtures a net stops
failing by being wrong and starts failing by being **believed**: a re-baseline
that blessed a regression, a shard that crashed and read as green, a golden
compared against bytes that no longer resemble what the normaliser emits. Every
rule here closes one of those.

```ts
import { assertNet, rebaselineNet, type Net } from "@gokayo43/dev-config/characterization-net.ts";

const net: Net<Endpoint, Payload> = {
  cases: ENDPOINTS,
  dir: `${import.meta.dir}/goldens`,
  nameOf: (endpoint) => `${endpoint.method}-${endpoint.path}`.replaceAll("/", "_"),
  capture: async (endpoint) => {
    const response = await app.handle(request(endpoint));
    return { status: response.status, body: await response.json() };
  },
  normalize: ({ status, body }) => ({ status, body: { ...body, id: "<id>", at: "<when>" } }),
};

test("the net", async () => {
  const report = await assertNet(net);
  expect(report.failures).toEqual([]);
});
```

`Body` is a type parameter, inferred from the literal, and that is what keeps
the narrowing out of every repo's normaliser: the one place a file off disk is
read back into that type is inside this module, under one reasoned suppression.

## The disciplines

Some are enforced. The first is better than enforced — it is unrepresentable.

**1. One build path for asserting and for re-baselining.** There is one
`capture` and one `normalize`, and both operations call them. The classic bug —
goldens updated through a different request-build than they are compared with —
is not something this refuses; it is something the interface cannot express.

**2. The committed golden is re-normalised before comparison.** Never trusted to
still be byte-identical to what today's normaliser would emit. A net that
compares raw bytes turns every normaliser change into a thousand-file
re-baseline, which is the diff nobody reads. It is also why nothing here sorts
keys: both sides of every comparison come out of the same normaliser and the
same `JSON.stringify`, so there is no ordering left for a canonicaliser to
reconcile.

**3. A golden is written only when it changed.** A re-baseline's diff is then
exactly the behaviour delta — the only thing that makes reviewing golden diffs
like code possible at all.

**4. Changing an existing golden needs a blessing.** `rebaselineNet(net, why)`
refuses every change when `why` is empty, and writes nothing. Creating a golden
needs none: a new case has no behaviour to regress. Overwriting one is blessing
whatever it used to pin, and a run that cannot say what it is blessing is one
nobody decided to do.

**5. Status is part of the golden, in the type, from day 0.** `Capture` holds
both and neither is optional. A sidecar mechanism for the status is accretive,
and an accretive mechanism covers whatever fraction of the net somebody got
round to — 12% of one, in the suite these rules were read off.

**6. Sharding is a pure function** of the case list and the shard count.
`assertNet(net, { index, count })` covers the cases whose position is its own, in
order, so a run at any parallelism — including one shard, and including the
serial fallback — covers exactly the same cases.

**7. Orphans fail.** A golden file no case claims is a case that was deleted and
a fixture that was not, and it will sit there being green forever. An unsharded
`assertNet` reconciles the directory; a shard cannot, since it sees a fraction of
the cases and would call the rest orphans.

**8. Every run answers with a summary line**, in `Report.summary`, always.

## What the repo still owns

Two things are deliberately not in this module, because their shape is the
repo's and shipping a guess would be worse than shipping nothing.

### The sharded driver, and the summary guard

A shard that died wrote no report at all, and that is how a crashed shard reads
as green. What closes it is a driver that knows how many shards it started and
fails when one of them produced no summary — asserted independently at the
driver and at the CI gate, so neither is the only thing standing between a crash
and a pass.

The driver also unions each shard's `report.ran` and reconciles the golden
directory against that union, which is the reconciliation an individual shard
cannot do.

### Outbound goldens

In replay mode, capture what the app **sends** to third parties and assert it
against committed goldens: canonicalised, order-independent, volatile keys
dropped. This is the house doctrine — fakes only at true external boundaries,
built from real captured payloads — extended to the egress side, where a change
in what we send is as much a behaviour change as a change in what we answer.

The rule that makes it work: **an unmodelled outbound read throws loudly.** A
silent fallback there masks a missing fixture and lets a golden drift, which is
the failure the whole net exists to prevent, arriving through the one door it
was not watching.

That store belongs to whatever the repo's HTTP client is, and canonicalising a
request is a fact about that client. `project-template` scaffolds the shape.

## Not carried

The suite these disciplines were read off is a port from PHP, and its
normaliser carries PHP's quirks — an empty object serialised as an array, PHP's
pretty-print spacing. That is migration scar tissue, correct there and wrong
anywhere else. A greenfield net must not inherit it.
