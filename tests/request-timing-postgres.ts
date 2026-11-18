/**
 * A Postgres database of a request-timing suite's own, on the server
 * `tests/postgres.ts` reads, holding the `presets` table the Bun.sql and
 * TanStack Start suites run against.
 */
import { SQL } from "bun";

import { SERVER } from "./postgres.ts";

let made = 0;

/**
 * A database named for the process that made it, so two runs on one server
 * never meet, with `presets` holding `first` and `second`, and dropped on
 * disposal. `url` reaches it.
 */
export async function scratchPostgres() {
  made += 1;
  const name = `request_timing_${process.pid}_${made}`;
  const server = new SQL(SERVER);
  await server.unsafe(`create database ${name}`);
  const url = new URL(SERVER);
  url.pathname = `/${name}`;
  const setup = new SQL(url.href);
  await setup.unsafe(
    "create table presets (id serial primary key, label varchar(64) not null unique)",
  );
  await setup.unsafe("insert into presets (label) values ('first'), ('second')");
  await setup.close();
  return {
    url: url.href,
    [Symbol.asyncDispose]: async () => {
      await server.unsafe(`drop database ${name} with (force)`);
      await server.close();
    },
  };
}
