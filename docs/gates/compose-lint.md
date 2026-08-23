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
  asserts it can never answer one — a path relative to the repository root,
  optionally with ` -- why` after it, and the gate refuses a value that is not a
  file in the repo. A one-shot job that exits is the honest case; "we did not get
  round to it" is the case the key is there to make visible.

  A reason string used to be the whole of it, and a lint cannot check a runtime
  — so any non-empty prose passed. One waiver in the fleet read "the runtime
  exits the process on a failure the loop cannot recover from", which was false,
  and the gate took it. It still cannot check the runtime; what it can do is
  insist the claim belongs to something that does. `x-no-healthcheck:
"apps/worker/tests/exit.test.ts -- no socket; the loop exits the process"` is
  a waiver a reviewer can follow, and a suite that stops asserting it is a red
  build rather than a sentence nobody re-read.

- a `migrate` service with `restart: "no"`, and every service that builds from
  this repo waiting on it with `condition: service_completed_successfully`. A
  failed migration then keeps the old container running rather than starting a
  new one against a schema it does not match, and a restart policy on a migration
  is a crash loop.

Services that only pull an image are infrastructure and are not asked to wait on
the migration they host.
