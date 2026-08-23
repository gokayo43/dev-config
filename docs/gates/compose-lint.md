# Repos this box runs as containers

`compose: true` reads `docker-compose.yml` and holds it to the deployment shape
every stack on this box shares:

- every published port bound to `127.0.0.1` — nginx is the only thing that should
  reach them, and the host firewall is not the only line of defence.
- no `network_mode: host`, or `x-host-network: "<why>"` where a service really
  needs the host's stack. Compose drops a host-networked service's `ports` key
  without a word, so every listener it opens is on every interface and the rule
  above has nothing left to check.
- a `mem_limit` on every service — several unrelated stacks share the box, and
  without caps the kernel OOM killer picks its victim by score rather than by who
  caused the spike.
- a healthcheck on every service, or `x-no-healthcheck` naming the **test** that
  asserts it can never answer one. A one-shot job that exits is the honest case;
  "we did not get round to it" is the case the key is there to make visible.

  A reason string used to be the whole of it, and a lint cannot check a runtime,
  so any non-empty prose passed. One waiver in the fleet read "the runtime exits
  the process on a failure the loop cannot recover from", which was false, and
  the gate took it. It still cannot check the runtime; what it can do is insist
  the claim belongs to something that does:

  ```yaml
  x-no-healthcheck: "apps/worker/tests/exit.test.ts -- no socket; the loop exits the process"
  ```

  **Exactly what is checked.** The value is a path followed by ` -- why`. Both
  halves are required, the way every other hatch here requires both: the test
  says the service cannot answer a probe, and the reason says why that is the
  design rather than something nobody got to. `./x.test.ts` and `x.test.ts` are
  read as one path. The path is refused unless it is both

  - **test-shaped** — one of `*.test.ts`, `*.test.tsx`, `*.spec.ts`,
    `*.spec.tsx`, which is `oxlint.base.json`'s own test override and so the
    same definition of "a test" every other tool in the fleet uses; and
  - **listed by git for this repository** — tracked, or written and not yet
    committed. Never a path `.gitignore` covers, never one under
    `node_modules`, and never one that walks out of the tree.

  It is git's listing rather than "does this file exist" deliberately. Asking
  the filesystem accepted `README.md`, `.gitignore`, a gitignored file,
  something under `node_modules` and `../../../etc/hostname` — every one of them
  a file the machine has, and none of them the test the key claims to name.

  A waiver is graded in that order — shape, then reason, then listing — so one
  mistake earns one diagnostic: prose in this key is told it is not a test
  rather than that it has no reason.

  What the gate still cannot check is whether that test asserts the thing. It
  moves the claim from a sentence nobody re-reads to a run that either agrees or
  goes red, and review does the rest.

- a `migrate` service with `restart: "no"`, and every service that builds from
  this repo waiting on it with `condition: service_completed_successfully`. A
  failed migration then keeps the old container running rather than starting a
  new one against a schema it does not match, and a restart policy on a migration
  is a crash loop.

Services that only pull an image are infrastructure and are not asked to wait on
the migration they host.
