// desk's database: Postgres, run inside this process by PGlite (PostgreSQL compiled to WebAssembly), so desk stays one
// process with no service of its own to start (the plan of "desk on Linear's stack": "Postgres holds the issues", and
// "One process, as now; no new services"). Its data lives in DB_DIR. A server Postgres can take its place later: the
// queries here are plain SQL.
import { PGlite } from "@electric-sql/pglite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_DIR } from "./config.ts";

let db: PGlite | null = null;

const SCHEMA = `
create table if not exists issues (
  slug text primary key,
  title text not null,
  priority text not null default 'none',
  state text not null default 'backlog',
  parent text,
  project text,
  folder text,
  protocol text,
  link text,
  landing text,
  session text,
  waiting_on text,
  waiting_since text,
  created text not null,
  body text not null default '',
  written text -- issue.md as desk last wrote it, which tells an editor's change from desk's own
);
create table if not exists projects (
  slug text primary key,
  title text not null,
  state text not null default 'active',
  created text not null,
  body text not null default '',
  written text
);
create table if not exists automations ( -- what happened to each of automations/*.md, which hold the rest (automations.ts)
  slug text primary key,
  seen text not null,
  fired text,
  chat text,
  ran text,
  note text not null default ''
);`;

export async function open(): Promise<PGlite> {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  // The data folder is a git repo of its own, for the issues: the database stays out of it.
  const ignore = join(dirname(DB_DIR), ".gitignore");
  if (!process.env.DESK_DB && !existsSync(ignore)) writeFileSync(ignore, "*\n");
  const opened = await PGlite.create(DB_DIR);
  await opened.exec(SCHEMA);
  // desk's database is a few MB: Postgres's default 128 MB of shared buffers only holds memory, about 50 MB of it. Set
  // once in postgresql.auto.conf, it applies from the next start.
  if ((await opened.query<{ shared_buffers: string }>("show shared_buffers")).rows[0]?.shared_buffers !== "16MB")
    await opened.exec("alter system set shared_buffers = '16MB'");
  db = opened;
  return opened;
}

export function sql(): PGlite {
  if (!db) throw new Error("The database is not open yet.");
  return db;
}

export async function close() {
  await db?.close();
  db = null;
}
