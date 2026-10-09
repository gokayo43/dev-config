import { isObject, type Problem, record } from "../_lib/gate.ts";

export interface Service {
  /** `<job>.<service>`, which is how a refusal names it. */
  readonly at: string;
  readonly image: string;
  readonly options: string;
}

/** A service and the workflow file that declares it. */
export interface Declared extends Service {
  readonly file: string;
}

/** The paths an image declares a VOLUME at, read for the image exactly as the workflow names it. */
export type VolumesOf = (image: string) => Promise<readonly string[]>;

/** `container: node:22` and `container: {image: node:22}` are one declaration, and a service is written the second way. */
export function imageOf(node: unknown): string[] {
  if (typeof node === "string") return [node];
  const image = record(node)["image"];
  return typeof image === "string" ? [image] : [];
}

/** Every service a workflow's jobs declare, with the options its container is created with. */
export function servicesIn(document: unknown): Service[] {
  return Object.entries(record(record(document)["jobs"])).flatMap(([job, body]) =>
    Object.entries(record(record(body)["services"])).flatMap(([name, service]) =>
      imageOf(service).map((image) => {
        const options = record(service)["options"];
        return {
          at: `${job}.${name}`,
          image,
          options: typeof options === "string" ? options : "",
        };
      }),
    ),
  );
}

/** Each `--tmpfs <path>[:<mount options>]` in a service's options, as path to its mount options. */
function tmpfsMounts(options: string): Map<string, string> {
  const words = options.split(/\s+/);
  const mounts = words.flatMap((word, at) => {
    const value = word === "--tmpfs" ? words[at + 1] : /^--tmpfs=(.+)$/.exec(word)?.[1];
    if (value === undefined) return [];
    const colon = value.indexOf(":");
    return [
      colon === -1
        ? ([value, ""] as const)
        : ([value.slice(0, colon), value.slice(colon + 1)] as const),
    ];
  });
  return new Map(mounts);
}

/**
 * Each declared volume needs a capped tmpfs over its exact path; README's
 * "Where it runs" has why. `size=0` is no cap, since tmpfs reads zero as
 * unlimited.
 */
export async function unmounted(
  services: readonly Declared[],
  volumesOf: VolumesOf,
): Promise<Problem[]> {
  const checked = await Promise.all(
    services.map(async ({ file, at, image, options }): Promise<Problem[]> => {
      let volumes: readonly string[];
      try {
        volumes = await volumesOf(image);
      } catch (error) {
        return [
          {
            file,
            message: `${at}: could not read the volumes ${image} declares: ${String(error)}`,
          },
        ];
      }
      const mounts = tmpfsMounts(options);
      return volumes.flatMap((path) => {
        const mount = mounts.get(path);
        if (mount === undefined) {
          return [
            {
              file,
              message: `${at}: ${image} declares a volume at ${path}, which the runner leaves behind after every run; add \`--tmpfs ${path}:size=<cap>\` to the service's options`,
            },
          ];
        }
        return mount.split(",").some((option) => /^size=[1-9]/.test(option))
          ? []
          : [
              {
                file,
                message: `${at}: the tmpfs at ${path} has no size cap, so a runaway run takes the box's memory; write it \`--tmpfs ${path}:size=<cap>\``,
              },
            ];
      });
    }),
  );
  return checked.flat();
}

/** The output of `docker image inspect --format '{{json .Config.Volumes}}'`: `null`, or an object keyed by path. */
export function volumesFromInspect(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (parsed === null) return [];
  if (!isObject(parsed)) throw new Error(`docker image inspect answered ${output.trim()}`);
  return Object.keys(parsed);
}

async function docker(args: readonly string[]): Promise<{ status: number; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, out: status === 0 ? stdout : stderr.trim() };
}

/**
 * The runner's own Docker, which is the one that will create the service. An
 * image it does not hold yet is pulled, which is the pull the job running the
 * service would otherwise make on the same runner.
 */
export const dockerVolumes: VolumesOf = async (image) => {
  const inspect = ["image", "inspect", "--format", "{{json .Config.Volumes}}", image];
  let read = await docker(inspect);
  if (read.status !== 0) {
    const pulled = await docker(["pull", "--quiet", image]);
    if (pulled.status !== 0) throw new Error(`docker pull: ${pulled.out}`);
    read = await docker(inspect);
    if (read.status !== 0) throw new Error(`docker image inspect: ${read.out}`);
  }
  return volumesFromInspect(read.out);
};
