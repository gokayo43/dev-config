import { n as waitOn, t as standingIn } from "./request-timing-wait-Cj7WA-Qu.js";
// request-timing-bun-redis.ts
/**
* `client` with every command it sends measured, one wait each, `send`
* included, and `connect` too, which is a wait on the store. `close` waits on
* nothing. A client made by `duplicate` is wrapped the same way, and making it
* is a wait. Every other member, `connected` and the `onconnect` and `onclose`
* callbacks among them, is read from and written to the client itself.
*/
function timedBunRedis(client) {
	const standIns = /* @__PURE__ */ new Map();
	for (const [key, member] of Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(client)))) {
		const method = member.value;
		if (typeof method === "function" && key !== "constructor") standIns.set(key, (...args) => waitOn("store", () => Promise.resolve(method.apply(client, args))));
	}
	standIns.set("close", () => client.close());
	standIns.set("duplicate", () => waitOn("store", () => client.duplicate()).then(timedBunRedis));
	return standingIn(client, standIns);
}
export { timedBunRedis };
