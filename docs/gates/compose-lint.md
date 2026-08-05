# Repos this box runs as containers

`compose: true` reads `docker-compose.yml` and holds it to the deployment shape
every stack on this box shares:

- every published port bound to `127.0.0.1` — nginx is the only thing that should
  reach them, and the host firewall is not the only line of defence.
- a `mem_limit` on every service — several unrelated stacks share the box, and
  without caps the kernel OOM killer picks its victim by score rather than by who
  caused the spike.
- a healthcheck on every service, or `x-no-healthcheck: "<why it can never answer
one>"`. A one-shot job that exits is the honest case; "we did not get round to
  it" is the case the key is there to make visible.
- a `migrate` service with `restart: "no"`, and every service that builds from
  this repo waiting on it with `condition: service_completed_successfully`. A
  failed migration then keeps the old container running rather than starting a
  new one against a schema it does not match, and a restart policy on a migration
  is a crash loop.

Services that only pull an image are infrastructure and are not asked to wait on
the migration they host.
