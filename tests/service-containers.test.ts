import { describe, expect, test } from "bun:test";

import { workflowGate } from "../.github/actions/lint-workflows/pins.ts";
import {
  servicesIn,
  volumesFromInspect,
  type VolumesOf,
} from "../.github/actions/lint-workflows/services.ts";
import { containing } from "./matchers.ts";
import { materialise, type Tree } from "./tree.ts";

const POSTGRES_16 =
  "postgres:16-alpine@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";
const POSTGRES_18 =
  "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const REDIS_7 =
  "redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf";
const ALPINE = "alpine:3@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b";
/** Pinned well enough for the pin rule, and held by no registry this box can read. */
const UNREADABLE = `ghcr.io/gokayo43/private-db@sha256:${"0".repeat(64)}`;

/**
 * `docker image inspect --format '{{json .Config.Volumes}}'` for each image, by
 * the whole reference a workflow pins: captured from this box's Docker, and
 * Postgres 18's from its registry config, which is where that output comes from.
 * The key is the pin rather than the name because a major release can move
 * the path: 16 declares `.../data`, 18 the directory above it.
 */
const INSPECTED = new Map([
  [POSTGRES_16, '{"/var/lib/postgresql/data":{}}\n'],
  [POSTGRES_18, '{"/var/lib/postgresql":{}}\n'],
  [REDIS_7, '{"/data":{}}\n'],
  [ALPINE, "null\n"],
]);

/** The gate's in-memory adapter: what Docker would answer, or Docker's refusal for an image it cannot find. */
const volumesOf: VolumesOf = (image) => {
  const output = INSPECTED.get(image);
  return output === undefined
    ? Promise.reject(new Error(`No such image: ${image}`))
    : Promise.resolve(volumesFromInspect(output));
};

function workflow(...services: readonly (readonly [string, string])[]): Tree {
  const declared = services.flatMap(([image, options], at) => [
    `      s${at}:`,
    `        image: ${image}`,
    ...(options === "" ? [] : [`        options: >-`, `          ${options}`]),
  ]);
  return {
    ".gitignore": "node_modules\n",
    ".github/workflows/db.yml": ["jobs:", "  check:", "    services:", ...declared, ""].join("\n"),
  };
}

async function refusals(...services: readonly (readonly [string, string])[]): Promise<string[]> {
  const problems = await workflowGate(await materialise(workflow(...services)), [], volumesOf);
  return problems.map(({ file, message }) => `${file ?? ""}: ${message}`);
}

describe("reading the services a workflow declares", () => {
  test("each service, by job, with the options its container is created with", () => {
    const document = Bun.YAML.parse(
      [
        "jobs:",
        "  a:",
        "    services:",
        "      postgres:",
        `        image: ${POSTGRES_16}`,
        "        options: --health-cmd pg_isready --tmpfs /var/lib/postgresql/data:size=1g",
        "      redis: redis:7",
        "  b:",
        "    steps: []",
      ].join("\n"),
    );
    expect(servicesIn(document)).toEqual([
      {
        at: "a.postgres",
        image: POSTGRES_16,
        options: "--health-cmd pg_isready --tmpfs /var/lib/postgresql/data:size=1g",
      },
      { at: "a.redis", image: "redis:7", options: "" },
    ]);
  });
});

describe("reading what docker image inspect answers", () => {
  test.each([
    ["an image declaring one volume", '{"/data":{}}\n', ["/data"]],
    ["an image declaring none", "null\n", []],
  ])("%s", (_what, output, expected) => {
    expect(volumesFromInspect(output)).toEqual(expected);
  });

  test("an answer that is not a volume map is refused", () => {
    expect(() => volumesFromInspect('"/data"\n')).toThrow("docker image inspect answered");
  });
});

// The wrong implementations: a gate that never looks at services; one that
// asks for any tmpfs, which passes a mount over a parent such as
// `/var/lib/postgresql` while Postgres 16's `.../data` still gets its volume;
// one that keys the declared path by image name, which reads 18 as 16; and one
// that asks for no cap, or reads `size=0`, tmpfs's own word for unlimited, as one.
describe("a service whose image declares a volume", () => {
  test("passes with a capped tmpfs over each declared path, in either spelling", async () => {
    expect(
      await refusals(
        [POSTGRES_16, "--health-cmd pg_isready --tmpfs /var/lib/postgresql/data:size=1g"],
        [REDIS_7, "--tmpfs=/data:rw,size=64m"],
        [POSTGRES_18, "--tmpfs /var/lib/postgresql:size=1g"],
      ),
    ).toEqual([]);
  });

  test("is refused without a tmpfs, with the line that fixes it", async () => {
    expect(await refusals([REDIS_7, "--health-cmd 'redis-cli ping'"])).toEqual([
      containing(
        ".github/workflows/db.yml: check.s0: " +
          `${REDIS_7} declares a volume at /data, which the runner leaves behind after every run; add \`--tmpfs /data:size=<cap>\``,
      ),
    ]);
  });

  test.each([
    ["a parent of the declared path", POSTGRES_16, "--tmpfs /var/lib/postgresql:size=1g"],
    ["the path an older major declared", POSTGRES_18, "--tmpfs /var/lib/postgresql/data:size=1g"],
  ])("is refused with a tmpfs over %s", async (_what, image, options) => {
    expect(await refusals([image, options])).toEqual([
      containing("which the runner leaves behind after every run"),
    ]);
  });

  test.each([
    ["no size", "--tmpfs /data"],
    ["a size of zero, which tmpfs reads as unlimited", "--tmpfs /data:size=0"],
  ])("is refused with a tmpfs of %s", async (_what, options) => {
    expect(await refusals([REDIS_7, options])).toEqual([
      containing("check.s0: the tmpfs at /data has no size cap"),
    ]);
  });
});

describe("a service the gate cannot read", () => {
  test("needs nothing when its image declares no volume", async () => {
    expect(await refusals([ALPINE, ""])).toEqual([]);
  });

  test("is named, and the services beside it are still graded", async () => {
    expect(await refusals([UNREADABLE, ""], [REDIS_7, ""])).toEqual([
      containing(`check.s0: could not read the volumes ${UNREADABLE} declares`),
      containing("check.s1: "),
    ]);
  });
});

// This repo's own workflows are the first callers of every service rule above,
// and the adapter refuses an image it holds no capture for, so a service added
// here without one fails rather than passing unexamined.
test("this repo's workflows leave no volume behind", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const problems = await workflowGate(root, [], volumesOf);
  expect(problems.map(({ file, message }) => `${file ?? ""}: ${message}`)).toEqual([]);
});
