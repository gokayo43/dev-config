/**
 * The Next.js app the Next.js and tRPC connectors' suites build and boot.
 * `next build` type-checks with the TypeScript package's own API, which the
 * TypeScript this repo pins does not have; the repo's own typecheck covers
 * these files instead.
 */
import type { NextConfig } from "next";

const config: NextConfig = { typescript: { ignoreBuildErrors: true } };

export default config;
