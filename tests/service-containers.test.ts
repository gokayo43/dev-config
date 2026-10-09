import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { record } from "../.github/actions/_lib/gate.ts";

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url).pathname;

/**
 * The data directory each service image declares a VOLUME, read off the pinned
 * digests with `docker image inspect -f '{{json .Config.Volumes}}'`. An image
 * missing here fails the suite rather than passing unexamined.
 */
const DECLARED_VOLUMES = new Map([
  ["postgres", "/var/lib/postgresql/data"],
  ["redis", "/data"],
]);

interface Service {
  readonly at: string;
  readonly image: string;
  readonly options: string;
}

async function services(): Promise<Service[]> {
  const files = (await readdir(WORKFLOWS)).filter((name) => /\.ya?ml$/.test(name));
  const found: Service[] = [];
  for (const file of files) {
    const document = record(Bun.YAML.parse(await Bun.file(`${WORKFLOWS}${file}`).text()));
    for (const [job, body] of Object.entries(record(document["jobs"]))) {
      for (const [name, service] of Object.entries(record(record(body)["services"]))) {
        const { image, options } = record(service);
        found.push({
          at: `${file} ${job}.${name}`,
          image: typeof image === "string" ? image : "",
          options: typeof options === "string" ? options : "",
        });
      }
    }
  }
  return found;
}

/** The paths the options mount a tmpfs at, each without its `:size=` and other mount options. */
function tmpfsPaths(options: string): string[] {
  const words = options.split(/\s+/);
  return words.flatMap((word, at) =>
    word === "--tmpfs" ? [(words[at + 1] ?? "").split(":")[0] ?? ""] : [],
  );
}

// The runner removes a service container with `docker rm --force` and no `-v`,
// after the job's last step, so an image's declared VOLUME outlives the job as
// an anonymous volume nothing removes: 197 of them filled the runner box's disk
// to 96%. A tmpfs over the declared path is what stops Docker creating one. The
// wrong implementations are a service with no tmpfs, and a tmpfs over a parent
// such as `/var/lib/postgresql`, which leaves the declared path to a volume all
// the same.
const SERVICES = await services();

describe("service containers", () => {
  test("the workflows declare some, so the cases below grade something", () => {
    expect(SERVICES.length).toBeGreaterThan(0);
  });

  test.each(SERVICES.map((service) => [service.at, service] as const))(
    "%s mounts a tmpfs over the data directory its image declares a volume",
    (_at, { image, options }) => {
      const declared = DECLARED_VOLUMES.get(image.split(/[:@]/)[0] ?? "");
      expect(declared).toBeDefined();
      expect(tmpfsPaths(options)).toContain(declared ?? "");
    },
  );
});
