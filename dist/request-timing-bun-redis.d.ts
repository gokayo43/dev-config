import { RedisClient } from "bun";
//#region request-timing-bun-redis.d.ts
/**
 * `client` with every command it sends measured, one wait each, `send`
 * included, and `connect` too, which is a wait on the store. `close` waits on
 * nothing. A client made by `duplicate` is wrapped the same way, and making it
 * is a wait. Every other member, `connected` and the `onconnect` and `onclose`
 * callbacks among them, is read from and written to the client itself.
 */
export declare function timedBunRedis(client: RedisClient): RedisClient;
//#endregion