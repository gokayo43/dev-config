import { type Problem, record } from "../_lib/gate.ts";

const MIGRATE = "migrate";
const OPT_OUT = "x-no-healthcheck";
const HOST_NETWORK_OPT_OUT = "x-host-network";

type Service = Record<string, unknown>;

function checkHealthcheck(name: string, service: Service, file: string): Problem[] {
  if (service["healthcheck"] !== undefined) return [];
  const reason = service[OPT_OUT];
  if (typeof reason === "string" && reason.trim() !== "") return [];
  return [
    {
      file,
      message: `${name} has no healthcheck — add one, or ${OPT_OUT}: "<why this service can never answer one>"`,
    },
  ];
}

function checkMemoryCap(name: string, service: Service, file: string): Problem[] {
  if (service["mem_limit"] !== undefined) return [];
  return [
    {
      file,
      message: `${name} has no mem_limit — unrelated stacks share this box, and without caps the OOM killer picks its victim by score rather than by who caused the spike`,
    },
  ];
}

function checkPorts(name: string, service: Service, file: string): Problem[] {
  const ports = service["ports"];
  if (!Array.isArray(ports)) return [];
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
function checkNetworkMode(name: string, service: Service, file: string): Problem[] {
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

function checkMigrationOrder(name: string, service: Service, file: string): Problem[] {
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

function checkMigrateService(services: Record<string, unknown>, file: string): Problem[] {
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

export function composeLint(file: string, text: string): Problem[] {
  const services = record(record(Bun.YAML.parse(text))["services"]);
  if (Object.keys(services).length === 0) {
    return [{ file, message: "the compose file declares no services" }];
  }

  return [
    ...checkMigrateService(services, file),
    ...Object.entries(services).flatMap(([name, value]) => {
      const service = record(value);
      return [
        ...checkHealthcheck(name, service, file),
        ...checkMemoryCap(name, service, file),
        ...checkPorts(name, service, file),
        ...checkNetworkMode(name, service, file),
        ...checkMigrationOrder(name, service, file),
      ];
    }),
  ];
}
