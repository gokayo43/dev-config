import { entry, inputs, publish } from "../_lib/gate.ts";
import { probeGate, secondsFrom } from "./probe.ts";

await entry(async () => {
  const read = inputs("probe-command", "probe-timeout", "health-url");

  await publish(
    await probeGate({
      // The action ran this from the project it was pointed at, and the command
      // is the repo's own, run the way the repo would run it.
      root: process.cwd(),
      command: read["probe-command"],
      // The same URL the boot step polled and the ramp measures, from the same
      // input. A second way of naming the app would be a second thing to get
      // wrong about which app the probe was talking to.
      url: read["health-url"],
      // Read before the command is looked at, so that a bound nobody can parse
      // is refused whether or not there is a probe to run under it.
      seconds: secondsFrom(read["probe-timeout"]),
    }),
  );
});
