import { must } from "./narrowing.js";
import { n as measure } from "./request-timing-CRXpA8f5.js";
// request-timing-wait.ts
/**
* What every wait connector is built from: a client the app already made,
* answered as itself with some of its members standing in for theirs, and the
* one way a call of it is measured. No export names this file; the connectors'
* builds share it as a chunk.
*/
const handled = () => void 0;
/**
* Calls `send` as a wait of `kind` for the current operation, and answers the
* very promise `send` answered, so the app awaits the driver's own promise with
* no turn added. `measure` is handed that same promise and ends the wait on it
* before the app can resume on it, so a wait is ended before the code after it
* runs. `measure`'s own copy carries nothing the answer does not, and its
* rejection is the answer's, which reaches the app there.
*/
function waitOn(kind, send) {
	let answer;
	measure(kind, () => {
		answer = send();
		return answer;
	}).then(void 0, handled);
	return must(answer);
}
/**
* `client`, with each member `standIns` names read from there instead, and
* every other member the client's own. The answer is a Proxy, so the app and
* its ORM see the same type, prototype, `instanceof`, events and fields. The
* client's own fields and accessors are read and written on the client itself,
* since a native client's accessors refuse any other `this`; a method the app
* calls on the answer runs with the answer as `this`, so a method of the
* client that calls another member reaches its stand-in.
*/
function standingIn(client, standIns) {
	return new Proxy(client, {
		get: (target, key) => standIns.has(key) ? standIns.get(key) : Reflect.get(target, key),
		set: (target, key, value) => Reflect.set(target, key, value)
	});
}
export { waitOn as n, standingIn as t };
