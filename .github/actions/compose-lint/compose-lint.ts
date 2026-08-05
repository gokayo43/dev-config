import { type Problem, report } from "../_lib/gate.ts";

const MIGRATE = "migrate";
const OPT_OUT = "x-no-healthcheck";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function checkPorts(name: string, service: Record<string, unknown>, problems: Problem[], file: string): void {
  const ports = service["ports"];
  if (!Array.isArray(ports)) return;
  for (const port of ports) {
    const bound =
      typeof port === "string"
        ? port.startsWith("127.0.0.1:")
        : record(port)["host_ip"] === "127.0.0.1";
    if (!bound) {
      problems.push({
        file,
        message: `${name} publishes ${JSON.stringify(port)} on every interface — nginx is the only thing that reaches these, so bind 127.0.0.1`,
      });
    }
  }
}

function checkMigrationOrder(
  name: string,
  service: Record<string, unknown>,
  problems: Problem[],
  file: string,
): void {
  if (name === MIGRATE || service["build"] === undefined) return;
  const dependsOn = service["depends_on"];
  const condition = record(record(dependsOn)[MIGRATE])["condition"];
  if (condition === "service_completed_successfully") return;
  problems.push({
    file,
    message: `${name} must depend_on ${MIGRATE} with condition: service_completed_successfully — a failed migration has to keep the old container running rather than start a new one against a schema it does not match`,
  });
}

export function composeLint(file: string, text: string): Problem[] {
  const problems: Problem[] = [];
  const services = record(record(Bun.YAML.parse(text))["services"]);

  if (Object.keys(services).length === 0) {
    return [{ file, message: "the compose file declares no services" }];
  }

  const migrate = services[MIGRATE];
  if (migrate === undefined) {
    problems.push({
      file,
      message: `there is no ${MIGRATE} service — migrations run as a one-shot container before anything serves`,
    });
  } else if (record(migrate)["restart"] !== "no") {
    problems.push({
      file,
      message: `${MIGRATE} must carry restart: "no" — a restart policy turns a failed migration into a crash loop`,
    });
  }

  for (const [name, value] of Object.entries(services)) {
    const service = record(value);

    if (service["healthcheck"] === undefined) {
      const reason = service[OPT_OUT];
      if (typeof reason !== "string" || reason.trim() === "") {
        problems.push({
          file,
          message: `${name} has no healthcheck — add one, or ${OPT_OUT}: "<why this service can never answer one>"`,
        });
      }
    }

    if (service["mem_limit"] === undefined) {
      problems.push({
        file,
        message: `${name} has no mem_limit — unrelated stacks share this box, and without caps the OOM killer picks its victim by score rather than by who caused the spike`,
      });
    }

    checkPorts(name, service, problems, file);
    checkMigrationOrder(name, service, problems, file);
  }

  return problems;
}

if (import.meta.main) {
  const file = Bun.argv[2] ?? "docker-compose.yml";
  report(composeLint(file, await Bun.file(file).text()));
}
