// desk's database: Postgres, run inside this process by PGlite (PostgreSQL compiled to WebAssembly), so desk stays one
// process with no service of its own to start (the plan of "desk on Linear's stack": "Postgres holds the issues", and
// "One process, as now; no new services"). Its data lives in DB_DIR. A server Postgres can take its place later: the
// queries here are plain SQL.
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
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
);`;

export async function open(): Promise<PGlite> {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  const opened = await PGlite.create(DB_DIR);
  await opened.exec(SCHEMA);
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
