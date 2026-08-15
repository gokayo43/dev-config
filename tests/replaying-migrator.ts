/**
 * The other shape of `db:migrate` the replay gate is written for: a hand-rolled
 * runner with no journal, which applies every migration on every run. Against
 * one of these the second replay is what proves the SQL is re-runnable, and a
 * fixture repo carrying this one is how the suite drives that half of the gate.
 */
import { readdir } from "node:fs/promises";

import { SQL } from "bun";

const url = Bun.env["DATABASE_URL"];
if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");

const folder = Bun.argv[2];
if (folder === undefined) throw new Error("usage: replaying-migrator.ts <migrations folder>");

const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).toSorted();
const client = new SQL(url);
for (const file of files) {
  await client.unsafe(await Bun.file(`${folder}/${file}`).text());
}
await client.close();
