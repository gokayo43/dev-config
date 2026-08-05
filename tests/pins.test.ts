import { describe, expect, test } from "bun:test";

import {
  ACTION_FILES,
  imagesIn,
  pinGate,
  referencesIn,
  unpinned,
} from "../.github/actions/lint-workflows/pins.ts";
import { containing } from "./matchers.ts";
import { materialise, type Tree } from "./tree.ts";

const COMMIT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIGEST = "sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";

function uses(...values: string[]): string[] {
  return unpinned(values.map((value) => ({ file: "w.yml", kind: "action", value }))).map(
    ({ message }) => message,
  );
}

function images(...values: string[]): string[] {
  return unpinned(values.map((value) => ({ file: "w.yml", kind: "image", value }))).map(
    ({ message }) => message,
  );
}

/** A Docker container action's metadata, which names its image where no `uses:` can reach it. */
function dockerAction(image: string): string {
  return `name: x\ndescription: y\nruns:\n  using: docker\n  image: ${image}\n`;
}

function dockerActionTree(image: string): Tree {
  return {
    ".gitignore": "node_modules\n",
    ".github/actions/dockery/action.yml": dockerAction(image),
  };
}

describe("reading uses out of a document", () => {
  // Each of these was a hole in the pattern this replaced: extra spacing after
  // the dash, a quoted value, a job-level `uses:` for a reusable workflow, and
  // a composite action's own steps.
  test("every shape a uses: can take is found", () => {
    const document = Bun.YAML.parse(
      [
        "jobs:",
        "  a:",
        "    steps:",
        `      -   uses: actions/checkout@${COMMIT}`,
        `      - uses: "oven-sh/setup-bun@${COMMIT}"`,
        "  b:",
        `    uses: owner/repo/.github/workflows/check.yml@${COMMIT}`,
        "runs:",
        "  steps:",
        `    - uses: actions/cache@${COMMIT}`,
      ].join("\n"),
    );
    expect(referencesIn(document).toSorted((a, b) => a.localeCompare(b))).toEqual([
      `actions/cache@${COMMIT}`,
      `actions/checkout@${COMMIT}`,
      `oven-sh/setup-bun@${COMMIT}`,
      `owner/repo/.github/workflows/check.yml@${COMMIT}`,
    ]);
  });
});

// An action is one of two things a job runs by reference; the images it runs
// in and beside are the other, and they were read by nothing.
describe("reading the images a job runs", () => {
  test("both container spellings, and every service", () => {
    const document = Bun.YAML.parse(
      [
        "jobs:",
        "  a:",
        "    container: node:22",
        "    services:",
        "      postgres:",
        `        image: postgres:16-alpine@${DIGEST}`,
        "      redis:",
        "        image: redis:7-alpine",
        "  b:",
        "    container:",
        "      image: oven/bun:1",
        "    steps:",
        `      - uses: actions/checkout@${COMMIT}`,
      ].join("\n"),
    );
    expect(imagesIn(document).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "node:22",
      "oven/bun:1",
      `postgres:16-alpine@${DIGEST}`,
      "redis:7-alpine",
    ]);
  });

  test("a document with no jobs has no images", () => {
    expect(imagesIn(Bun.YAML.parse("runs:\n  using: composite\n"))).toEqual([]);
  });

  // A Docker container action names its image in metadata rather than in a
  // `uses:`, so neither walk reached it and its tag moved freely.
  test("a docker action's image is read off its metadata", () => {
    expect(imagesIn(Bun.YAML.parse(dockerAction("docker://alpine:3.22")))).toEqual([
      "docker://alpine:3.22",
    ]);
    // The Dockerfile form names a build in the repo at this commit, not a
    // registry reference, so there is no digest to ask for.
    expect(imagesIn(Bun.YAML.parse(dockerAction("Dockerfile")))).toEqual([]);
    expect(imagesIn(Bun.YAML.parse(dockerAction("./docker/Dockerfile")))).toEqual([]);
  });
});

describe("pinning", () => {
  test("a commit SHA passes, in every position", () => {
    expect(
      uses(`actions/checkout@${COMMIT}`, `owner/repo/.github/workflows/x.yml@${COMMIT}`),
    ).toEqual([]);
  });

  test("a local action carries no ref and needs none", () => {
    expect(uses("./.github/actions/secret-scan")).toEqual([]);
  });

  test.each([
    "actions/checkout@v5",
    "some/action@main",
    "owner/repo/.github/workflows/x.yml@v0.8.3",
  ])("a floating ref (%s) is refused", (value) => {
    expect(uses(value)).toEqual([containing("is not pinned")]);
  });

  test("a short SHA is not a commit pin", () => {
    expect(uses("some/action@3d3c42e")).toEqual([containing("is not pinned")]);
  });

  // The pattern this replaced skipped every docker:// reference while its
  // comment claimed they were pinned by digest syntax.
  test("a docker image tag is refused, and its digest is not", () => {
    expect(uses("docker://alpine:3.22")).toEqual([containing("mutable image tag")]);
    expect(uses(`docker://alpine@${DIGEST}`)).toEqual([]);
  });

  // A service is the same registry reference a docker:// action is, and a tag
  // moves under it just as freely.
  test("a job's image is held to the digest rule, not the commit rule", () => {
    expect(images("postgres:16-alpine")).toEqual([containing("mutable image tag")]);
    expect(images("postgres:16-alpine@sha256:short")).toEqual([containing("mutable image tag")]);
    expect(images(`postgres:16-alpine@${DIGEST}`)).toEqual([]);
  });
});

describe("the files read", () => {
  const CLEAN: Tree = {
    ".gitignore": "node_modules\n",
    ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${COMMIT}\n`,
    ".github/workflows/lighthouse.yaml": `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n`,
    ".github/actions/one/action.yml": `runs:\n  steps:\n    - uses: actions/cache@${COMMIT}\n`,
    ".github/actions/nested/deeper/action.yaml": `runs:\n  steps:\n    - uses: actions/cache@v4\n`,
    "setup/ci.yml": `jobs:\n  a:\n    uses: owner/repo/.github/workflows/check.yml@main\n`,
  };

  test("both spellings, at any depth, and the extra paths", async () => {
    const root = await materialise(CLEAN);
    const problems = (await pinGate(root, ["setup/*.yml"])).map(({ file }) => file ?? "");
    expect(problems.toSorted((a, b) => (a < b ? -1 : 1))).toEqual([
      ".github/actions/nested/deeper/action.yaml",
      ".github/workflows/lighthouse.yaml",
      "setup/ci.yml",
    ]);
  });

  // The gate walked `uses:` alone, so a job could run every action by SHA
  // inside a service image that moves under it whenever the tag is repushed.
  test("the images a job declares are read out of the file its actions are", async () => {
    const workflow = (image: string): Tree => ({
      ".gitignore": "node_modules\n",
      ".github/workflows/db.yml": [
        "jobs:",
        "  check:",
        "    container: oven/bun:1@" + DIGEST,
        "    services:",
        "      postgres:",
        `        image: ${image}`,
        "    steps:",
        `      - uses: actions/checkout@${COMMIT}`,
        "",
      ].join("\n"),
    });

    const mutable = await pinGate(await materialise(workflow("postgres:16-alpine")), []);
    expect(mutable.map(({ file, message }) => `${file ?? ""}: ${message}`)).toEqual([
      containing(".github/workflows/db.yml: postgres:16-alpine is a mutable image tag"),
    ]);
    expect(await pinGate(await materialise(workflow(`postgres:16-alpine@${DIGEST}`)), [])).toEqual(
      [],
    );
  });

  test("a docker action's image is refused by the file that declares it", async () => {
    const mutable = await pinGate(await materialise(dockerActionTree("docker://alpine:3.22")), []);
    expect(mutable.map(({ file, message }) => `${file ?? ""}: ${message}`)).toEqual([
      containing(".github/actions/dockery/action.yml: docker://alpine:3.22 is a mutable image tag"),
    ]);
    expect(
      await pinGate(await materialise(dockerActionTree(`docker://alpine@${DIGEST}`)), []),
    ).toEqual([]);
    expect(await pinGate(await materialise(dockerActionTree("Dockerfile")), [])).toEqual([]);
  });

  test("an extra path that matches nothing is how a renamed file stops being checked", async () => {
    const root = await materialise(CLEAN);
    const messages = (await pinGate(root, ["setup/renamed-*.yml"])).map(({ message }) => message);
    expect(messages[0]).toEqual(containing("matched no file"));
    expect(messages).toHaveLength(3);
  });

  // One unparseable workflow used to reject the batch, taking every finding the
  // other files had already produced with it and naming no file at all.
  test("a workflow that will not parse is named, and the rest are still read", async () => {
    const root = await materialise({
      ...CLEAN,
      ".github/workflows/broken.yml": "jobs:\n  a:\n   - oops\n  b: [",
    });
    const problems = (await pinGate(root, [])).map(({ file }) => file ?? "");
    expect(problems).toContain(".github/workflows/broken.yml");
    expect(problems).toContain(".github/workflows/lighthouse.yaml");
  });

  test("node_modules is never walked, whatever the repo ignores", async () => {
    const root = await materialise({
      ...CLEAN,
      ".gitignore": "dist\n",
      "node_modules/some-action/.github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n",
    });
    expect((await pinGate(root, [])).map(({ file }) => file ?? "")).not.toContain(
      "node_modules/some-action/.github/workflows/ci.yml",
    );
  });
});

// ci.yml runs its own pass over the composite actions — the one actionlint
// cannot read — and it has to reach the same files this gate does. Two lists
// that drift leave a spelling checked by one and not the other.
describe("the composite check looks where the pin gate looks", () => {
  test("ci.yml's pathspec covers every action spelling", async () => {
    const ci = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    const pathspec = /git ls-files '(\.github\/actions\/[^']+)'/.exec(ci)?.[1];
    expect(pathspec).toBeDefined();
    for (const pattern of ACTION_FILES) {
      expect(pathspec).toBe(pattern.replace(/\.ya?ml$/, ".y*ml"));
    }
  });
});
