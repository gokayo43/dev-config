import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["invariant-sweep.ts", "route-log.ts"],
  platform: "neutral",
  dts: true,
  deps: { dts: { neverBundle: true } },
});
