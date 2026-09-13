/**
 * GitHub's own SSH host keys, as the `known_hosts` file an install's `ssh`
 * decides against.
 *
 * READ rather than pinned: a copy in this repo would outlive GitHub's next
 * rotation and take every consuming repo's install down with it until the pin
 * moved, so the run reads them over TLS from the host it is about to clone
 * from.
 */
import { isList, record } from "../_lib/gate.ts";

/**
 * Each key under BOTH names GitHub answers on: a machine whose outbound `:22`
 * is closed reaches it as `[ssh.github.com]:443` through its own ssh config,
 * and the two endpoints serve identical keys (compared with `ssh-keyscan`,
 * 2026-09-11).
 */
const HOSTS = "github.com,[ssh.github.com]:443";

/**
 * `metaUrl` is GitHub's `/meta`, and `token` is not optional: unauthenticated,
 * that endpoint allows 60 calls an hour PER IP — which every runner on one host
 * shares — against 5,000 with a credential (measured 2026-09-11,
 * `x-ratelimit-limit`). A 403 there fails an install that has nothing wrong
 * with it.
 */
export async function knownHosts(metaUrl: string, token: string): Promise<string> {
  const answer = await fetch(metaUrl, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!answer.ok) throw new Error(`${metaUrl} answered ${answer.status}`);

  const published = record(await answer.json())["ssh_keys"];
  if (!isList(published) || published.length === 0) {
    throw new Error(`${metaUrl} published no ssh_keys`);
  }

  return published.map((key) => `${HOSTS} ${String(key)}\n`).join("");
}
