// desk's database: Postgres, run inside this process by PGlite (PostgreSQL compiled to WebAssembly), so desk stays one
// process with no service of its own to start (the plan of "desk on Linear's stack": "Postgres holds the issues", and
// "One process, as now; no new services"). Its data lives in DB_DIR. A server Postgres can take its place later: the
// queries here are plain SQL.
//
// The center of desk's data ("what to be the center of data. which should be api and db", the user, 19 Oct): every
// write to a table the app holds goes through write() here, one at a time and in one transaction, and a trigger numbers
// each row it changes in the log, changes, in that same transaction, whoever writes: the API, desk itself, or the
// read-in of an issue.md edited by hand. Once it commits, sync.ts sends what was logged to every open app, and an app
// that lost desk asks for only what it missed (since). Reads go through sql().
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_DIR } from "./config.ts";

let db: PGlite | null = null;

// What a query can run on: the database, or a write's transaction, which every query of the write must use.
export type Db = Pick<Transaction, "query">;

// The tables the app holds, each with its key and the columns it is not sent: a description, and the text desk last
// wrote, stay on the server.
const HELD: Record<string, { key: string; hidden: string[] }> = {
  issues: { key: "slug", hidden: ["body", "written"] },
  projects: { key: "slug", hidden: ["body", "written"] },
  chats: { key: "id", hidden: ["folder", "cwd", "seen", "extra"] },
};

// The row as the app holds it, in SQL, from a row named t.
const shown = (table: string) => `to_jsonb(t)${HELD[table].hidden.map((c) => ` - '${c}'`).join("")}`;

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
  landed text,
  session text,
  waiting_on text,
  waiting_since text,
  review_of text,
  review_since text,
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
create table if not exists chats ( -- desk's chats (chats.ts): each a session, and the issue it works, if any
  id text primary key,
  kind text,
  title text not null,
  created text not null,
  updated text,
  session text not null default '',
  issue text,
  folder text,
  cwd text,
  agent text,
  bare boolean not null default false,
  named text,
  "from" text,
  automation text,
  seen double precision,
  extra jsonb not null default '{}' -- what else its file held, such as the messages of a chat from before the panel
);
create table if not exists automations ( -- what happened to each of automations/*.md, which hold the rest (automations.ts)
  slug text primary key,
  seen text not null,
  fired text,
  chat text,
  ran text,
  note text not null default ''
);
create table if not exists changes ( -- the log: each change to a row the app holds, numbered as it was written
  seq bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null, -- the table
  key text not null,
  row jsonb -- the row as the app holds it, or null for a row deleted
);
create table if not exists meta (name text primary key, value text not null);
-- The log's own name, so an app that asks for what it missed from another database's log gets every row afresh; and
-- the newest change pruned from it, below which it no longer reaches.
insert into meta values ('log', gen_random_uuid()::text), ('pruned', '0') on conflict do nothing;
-- Logs the row a write changed, in the write's transaction. Its arguments: the table's key, then the columns the app is
-- not sent.
create or replace function logged() returns trigger language plpgsql as $$
declare
  r jsonb;
  hide text;
begin
  if tg_op = 'DELETE' then
    insert into changes (kind, key) values (tg_table_name, to_jsonb(old) ->> tg_argv[0]);
  else
    r := to_jsonb(new);
    foreach hide in array tg_argv[1:] loop
      r := r - hide;
    end loop;
    insert into changes (kind, key, row) values (tg_table_name, r ->> tg_argv[0], r);
  end if;
  return null;
end $$;
${Object.entries(HELD).map(([table, { key, hidden }]) => {
  const args = [key, ...hidden].map((c) => `'${c}'`).join(", ");
  // An update that changes nothing, as a save of what the row already holds, logs nothing.
  return `create or replace trigger ${table}_logged after insert or delete on ${table} for each row execute function logged(${args});
create or replace trigger ${table}_updated after update on ${table} for each row when (old is distinct from new) execute function logged(${args});`;
}).join("\n")}`;

export async function open(): Promise<PGlite> {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  // The data folder is a git repo of its own, for the issues: the database stays out of it.
  const ignore = join(dirname(DB_DIR), ".gitignore");
  if (!process.env.DESK_DB && !existsSync(ignore)) writeFileSync(ignore, "*\n");
  const opened = await PGlite.create(DB_DIR);
  await opened.exec(SCHEMA);
  await opened.exec(["review_of", "review_since", "landed"].map((c) => `alter table issues add column if not exists ${c} text;`).join(" "));
  // desk's database is a few MB: Postgres's default 128 MB of shared buffers only holds memory, about 50 MB of it. Set
  // once in postgresql.auto.conf, it applies from the next start.
  if ((await opened.query<{ shared_buffers: string }>("show shared_buffers")).rows[0]?.shared_buffers !== "16MB")
    await opened.exec("alter system set shared_buffers = '16MB'");
  db = opened;
  pushed = await last(opened);
  await prune();
  return opened;
}

export function sql(): PGlite {
  if (!db) throw new Error("The database is not open yet.");
  return db;
}

// --- writing ---------------------------------------------------------------------------------------------------------

export interface Change {
  seq: number;
  kind: string; // the table
  key: string;
  row: Record<string, unknown> | null; // as the app holds it; null once deleted
}

let queue: Promise<unknown> = Promise.resolve();
let pushed = 0; // the newest change told to the apps
let tell: (changes: Change[], after: number) => void = () => {};

// One at a time: each write, and each read of the log that must not see a write half told.
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// The one way to write a row: fn's queries run in one transaction, which every query of it must use, never sql(),
// whose query would wait for this transaction to end. Once it commits, what it logged is told (onWrite). A write must
// not start another.
export function write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return locked(async () => {
    const done = await sql().transaction(fn);
    await told();
    return done;
  });
}

// sync.ts hears here of each write's changes, with the change told before them.
export const onWrite = (fn: typeof tell) => { tell = fn; };

const last = async (q: Db) => Number((await q.query<{ seq: number | null }>("select max(seq) as seq from changes")).rows[0].seq ?? 0);

async function told() {
  const after = pushed;
  const fresh = (await sql().query<Change>("select seq, kind, key, row from changes where seq > $1 order by seq", [after])).rows;
  if (!fresh.length) return;
  pushed = Number(fresh.at(-1)!.seq);
  tell(fresh.map((c) => ({ ...c, seq: Number(c.seq) })), after);
}

// --- what an app is sent ------------------------------------------------------------------------------------------------

const meta = async (name: string) => (await sql().query<{ value: string }>("select value from meta where name = $1", [name])).rows[0]?.value ?? "";

// Every row the app holds, by table, with the log's name and the newest change in them. Under locked, so no write
// lands between it and the changes told after it.
export async function snapshot(): Promise<{ log: string; seq: number; rows: Record<string, Record<string, unknown>[]> }> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [table, { key }] of Object.entries(HELD))
    rows[table] = (await sql().query<{ row: Record<string, unknown> }>(`select ${shown(table)} as row from ${table} t order by ${key} collate "C"`)).rows.map((r) => r.row);
  return { log: await meta("log"), seq: pushed, rows };
}

// What an app that holds this log up to seq missed, in order; null when it must take every row afresh: the log is
// another database's, or no longer reaches back that far, or so much moved that every row is the smaller answer.
// Under locked, as snapshot.
const AFRESH = 500; // changes
export async function since(log: string, seq: number): Promise<Change[] | null> {
  if (log !== (await meta("log")) || !Number.isInteger(seq) || seq > pushed || seq < Number(await meta("pruned"))) return null;
  if (pushed - seq > AFRESH) return null;
  const missed = await sql().query<Change>("select seq, kind, key, row from changes where seq > $1 and seq <= $2 order by seq", [seq, pushed]);
  return missed.rows.map((c) => ({ ...c, seq: Number(c.seq) }));
}

// The log keeps a week: a tab away longer takes every row afresh. The newest change stays, whatever its age, so the
// log always knows its last number.
const KEEP = "7 days";
export function prune(): Promise<void> {
  return locked(async () => {
    const gone = await sql().query<{ seq: number }>(
      `delete from changes where at < now() - interval '${KEEP}' and seq < (select max(seq) from changes) returning seq`);
    if (!gone.rows.length) return;
    const top = Math.max(...gone.rows.map((r) => Number(r.seq)));
    await sql().query("update meta set value = $1 where name = 'pruned' and value::bigint < $1", [String(top)]);
  });
}

export async function close() {
  await db?.close();
  db = null;
}
