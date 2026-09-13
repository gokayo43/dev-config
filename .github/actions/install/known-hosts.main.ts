import { entry, inputs, required } from "../_lib/gate.ts";
import { knownHosts } from "./known-hosts.ts";

await entry(async () => {
  const read = inputs("meta-url", "github-token");
  if (read["github-token"] === "") {
    throw new Error(
      "github-token is empty — the host-key lookup would fall to the unauthenticated ceiling of 60 an hour per IP, which every runner on a host shares",
    );
  }

  const into = required(
    "KNOWN_HOSTS",
    "the install action's own shell names the file the host keys are written to",
  );

  await Bun.write(into, await knownHosts(read["meta-url"], read["github-token"]));
});
