/**
 * The app's database and its one outbound send, as the warehouse builds them:
 * a mysql2 pool under drizzle, and `fetch`, each wrapped by its connector while
 * timing is on. Made on the first request that reaches them.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { createPool } from "mysql2/promise";

import { timedFetch } from "../../../request-timing-fetch.ts";
import { timedPool } from "../../../request-timing-mysql2.ts";
import { databaseUrl, outsideUrl, timed } from "./env.ts";

export const presets = mysqlTable("presets", {
  id: int().primaryKey().autoincrement(),
  label: varchar({ length: 64 }).notNull().unique(),
});

function connect() {
  const pool = createPool({ uri: databaseUrl(), connectionLimit: 4 });
  const send = timed ? timedFetch(fetch) : fetch;
  const outside = outsideUrl();
  return {
    db: drizzle(timed ? timedPool(pool) : pool),
    send: (path: string) => send(new URL(path, outside)),
  };
}

let connected: ReturnType<typeof connect> | undefined;

export function clients() {
  connected ??= connect();
  return connected;
}

export type Database = ReturnType<typeof clients>["db"];

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
