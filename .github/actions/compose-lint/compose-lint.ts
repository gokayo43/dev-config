import { type ConfigObject, isList, type Problem, REASON, record } from "../_lib/gate.ts";

const MIGRATE = "migrate";
const OPT_OUT = "x-no-healthcheck";
const HOST_NETWORK_OPT_OUT = "x-host-network";

/**
 * The healthcheck waiver, which is a path to the test that asserts the service
 * can never answer one — optionally with the house ` -- reason` after it, the
 * way every allowlist entry here carries prose beside its subject.
 *
 * A path rather than the prose it used to be. What the key waives is a claim
 * about a service's runtime, and a lint cannot check a runtime — but it can
 * insist the claim belongs to something that can. Prose alone passed whatever
 * anybody typed: one waiver in the fleet read "the runtime exits the process on
 * a failure the loop cannot recover from", which was false, and the gate took
 * it. Naming the test moves the claim somewhere a run either agrees with or
 * does not.
 */
function waivedBy(service: ConfigObject): string | undefined {
  const value = service[OPT_OUT];
  if (typeof value !== "string") return undefined;
  const [path = ""] = value.split(REASON);
  const named = path.trim();
  return named === "" ? undefined : named;
}

async function checkHealthcheck(
  name: string,
  service: ConfigObject,
  file: string,
  root: string,
): Promise<Problem[]> {
  if (service["healthcheck"] !== undefined) return [];
  const named = waivedBy(service);
  if (named === undefined) {
    return [
      {
        file,
        message: `${name} has no healthcheck — add one, or waive it with ${OPT_OUT}: "<path to the test asserting it can never answer one>${REASON}<why>"`,
      },
    ];
  }
  if (await Bun.file(`${root}/${named}`).exists()) return [];
  return [
    {
      file,
      message: `${name}'s ${OPT_OUT} names ${named}, which is not a file in this repo — write the test that asserts this service can never answer a healthcheck, and point the waiver at it`,
    },
  ];
}

function checkMemoryCap(name: string, service: ConfigObject, file: string): Problem[] {
  if (service["mem_limit"] !== undefined) return [];
  return [
    {
      file,
      message: `${name} has no mem_limit — unrelated stacks share this box, and without caps the OOM killer picks its victim by score rather than by who caused the spike`,
    },
  ];
}

function checkPorts(name: string, service: ConfigObject, file: string): Problem[] {
  const ports = service["ports"];
  if (!isList(ports)) return [];
  return ports
    .filter((port) =>
      typeof port === "string"
        ? !port.startsWith("127.0.0.1:")
        : record(port)["host_ip"] !== "127.0.0.1",
    )
    .map((port) => ({
      file,
      message: `${name} publishes ${JSON.stringify(port)} on every interface — nginx is the only thing that reaches these, so bind 127.0.0.1`,
    }));
}

/**
 * Compose drops a host-networked service's `ports` key without a word, so every
 * listener it opens is on every interface and the loopback rule above has
 * nothing left to check.
 */
function checkNetworkMode(name: string, service: ConfigObject, file: string): Problem[] {
  if (service["network_mode"] !== "host") return [];
  const reason = service[HOST_NETWORK_OPT_OUT];
  if (typeof reason === "string" && reason.trim() !== "") return [];
  return [
    {
      file,
      message: `${name} runs with network_mode: host — compose ignores its ports and it listens on every interface. Publish through the loopback instead, or ${HOST_NETWORK_OPT_OUT}: "<why this service has to share the host's stack>"`,
    },
  ];
}

function checkMigrationOrder(name: string, service: ConfigObject, file: string): Problem[] {
  if (name === MIGRATE || service["build"] === undefined) return [];
  const condition = record(record(service["depends_on"])[MIGRATE])["condition"];
  if (condition === "service_completed_successfully") return [];
  return [
    {
      file,
      message: `${name} must depend_on ${MIGRATE} with condition: service_completed_successfully — a failed migration has to keep the old container running rather than start a new one against a schema it does not match`,
    },
  ];
}

function checkMigrateService(services: ConfigObject, file: string): Problem[] {
  const migrate = services[MIGRATE];
  if (migrate === undefined) {
    return [
      {
        file,
        message: `there is no ${MIGRATE} service — migrations run as a one-shot container before anything serves`,
      },
    ];
  }
  if (record(migrate)["restart"] === "no") return [];
  return [
    {
      file,
      message: `${MIGRATE} must carry restart: "no" — a restart policy turns a failed migration into a crash loop`,
    },
  ];
}

/**
 * `root` is the repository the compose file sits in, which the healthcheck
 * waiver reads: the test it names is the whole of what makes that waiver a
 * claim rather than a sentence.
 */
export async function composeLint(root: string, file: string, text: string): Promise<Problem[]> {
  const services = record(record(Bun.YAML.parse(text))["services"]);
  if (Object.keys(services).length === 0) {
    return [{ file, message: "the compose file declares no services" }];
  }

  const perService = await Promise.all(
    Object.entries(services).map(async ([name, value]) => {
      const service = record(value);
      return [
        ...(await checkHealthcheck(name, service, file, root)),
        ...checkMemoryCap(name, service, file),
        ...checkPorts(name, service, file),
        ...checkNetworkMode(name, service, file),
        ...checkMigrationOrder(name, service, file),
      ];
    }),
  );

  return [...checkMigrateService(services, file), ...perService.flat()];
}
