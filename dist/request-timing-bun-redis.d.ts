/**
 * Request timing's connector for Bun's own Redis client: every command a
 * client sends, counted as one `store` wait of the operation that sent it.
 * `docs/exports/request-timing.md` says what an app mounts and what a count
 * includes.
 *
 * Bun's client has no method every command passes through and no batch
 * object: each command is a native method of its own, so every method is a
 * wait, and each is called on the client itself, since its methods and
 * accessors refuse any other `this`.
 */
import { RedisClient } from "bun";
/**
 * `client` with every command it sends measured, one wait each, `send`
 * included, and `connect` too, which is a wait on the store. `close` waits on
 * nothing. A client made by `duplicate` is wrapped the same way, and making it
 * is a wait. Every other member, `connected` and the `onconnect` and `onclose`
 * callbacks among them, is read from and written to the client itself.
 */
export declare function timedBunRedis(client: RedisClient): RedisClient;