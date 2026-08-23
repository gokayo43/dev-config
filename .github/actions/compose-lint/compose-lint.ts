import {
  type ConfigObject,
  isList,
  type Problem,
  REASON,
  record,
  repoFiles,
} from "../_lib/gate.ts";

const MIGRATE = "migrate";
const OPT_OUT = "x-no-healthcheck";
const HOST_NETWORK_OPT_OUT = "x-host-network";

/**
 * What counts as a test file, which is `oxlint.base.json`'s own test override —
 * the one definition the fleet already lints by. `tests/compose-lint.test.ts`
 * holds the two lists equal, so this is a copy that cannot drift rather than a
 * second opinion.
 */
export const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"];

/**
 * The same set with the leading globstar dropped, which is how both readers here
 * want it. A git pathspec's `*` already crosses "/", so these reach any depth,
 * while the globstar prefix would demand a directory and miss a test at the
 * root. `Bun.Glob`'s `*` does not cross "/", which is why the match below is
 * against a basename.
 */
const TEST_NAMES = TEST_FILES.map((glob) => glob.replace("**/", ""));

function looksLikeATest(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return TEST_NAMES.some((glob) => new Bun.Glob(glob).match(name));
}

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

function checkHealthcheck(
  name: string,
  service: ConfigObject,
  file: string,
  tests: ReadonlySet<string>,
): Problem[] {
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
  if (!looksLikeATest(named)) {
    return [
      {
        file,
        message: `${name}'s ${OPT_OUT} names ${named}, which is not a test — the waiver points at the test that asserts this service can never answer a healthcheck, as a ${TEST_NAMES.join(" / ")} path from the repository root`,
      },
    ];
  }
  if (tests.has(named)) return [];
  return [
    {
      file,
      message: `${name}'s ${OPT_OUT} names ${named}, which git does not list in this repo — write that test and commit it, then point the waiver at it; a path outside the repo or one .gitignore covers is not a claim anybody can check`,
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
 * `root` is the repository the compose file sits in, and the one thing read out
 * of it is the set of test files: a healthcheck waiver names one, and that name
 * is the whole of what makes the waiver a claim rather than a sentence.
 *
 * Listed once, up front, through git rather than by asking the filesystem
 * whether each named path exists. `Bun.file(...).exists()` answered yes to
 * README.md, to .gitignore, to a file .gitignore covers, to something under
 * node_modules and to `../../../etc/hostname` — none of which is a test in this
 * repo, which is what the key claims to name. git's listing is the claim
 * itself: tracked or newly written, never ignored, never outside the tree, and
 * a name never reaches git as a pathspec where it could escape.
 */
export async function composeLint(root: string, file: string, text: string): Promise<Problem[]> {
  const services = record(record(Bun.YAML.parse(text))["services"]);
  if (Object.keys(services).length === 0) {
    return [{ file, message: "the compose file declares no services" }];
  }

  const tests = new Set(await repoFiles(root, TEST_NAMES));

  return [
    ...checkMigrateService(services, file),
    ...Object.entries(services).flatMap(([name, value]) => {
      const service = record(value);
      return [
        ...checkHealthcheck(name, service, file, tests),
        ...checkMemoryCap(name, service, file),
        ...checkPorts(name, service, file),
        ...checkNetworkMode(name, service, file),
        ...checkMigrationOrder(name, service, file),
      ];
    }),
  ];
}
