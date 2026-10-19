// desk's database: Postgres, run inside this process by PGlite (PostgreSQL compiled to WebAssembly), so desk stays one
// process with no service of its own to start (the plan of "desk on Linear's stack": "Postgres holds the issues", and
// "One process, as now; no new services"). Its data lives in DB_DIR. A server Postgres can take its place later: the
// queries here are plain SQL.
//
// The center of desk's data ("what to be the center of data. which should be api and db", the user, 19 Oct): every
// write to a table the app holds goes through write() here, one at a time and in one transaction, and a trigger numbers
// each row it changes in the log, changes, in that same transaction, whoever writes: the API or desk itself. Once it
// commits, sync.ts sends what was logged to every open app, and an app that lost desk asks for only what it missed
// (since). Reads go through sql().
//
// The tables are the record of desk's state ("you should find whatever represent state, should be in db", the user, 19
// Oct): issues and projects, the Inbox, the trash, pins, each session's model, settings, Slack's tags and the line. issue.md and
// project.md are only written out, for agents, git and an editor to read; desk reads them in only into a database
// with no issues yet, as a new one (issues.importAll).
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
  inbox: { key: "id", hidden: [] },
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
create table if not exists trashed ( -- each issue deleted into the trash, as its row was, until a restore puts it back
  slug text primary key,
  bin text not null, -- the issue whose delete took it: its folder in TRASH_DIR
  row jsonb not null
);
create table if not exists pins ( -- the sessions pinned to the sidebar's Pinned (pins.ts)
  session text primary key,
  seq bigint generated always as identity -- the order they were pinned in
);
create table if not exists session_models ( -- the model and effort picked for a session (models.ts)
  session text primary key,
  model text,
  effort text
);
create table if not exists settings (name text primary key, value jsonb not null); -- each one set (settings.ts)
create table if not exists slack_filed ( -- each Slack message tagged 🐧 that desk handled, "<channel>/<ts>" (slack.ts)
  message text primary key,
  seq bigint generated always as identity
);
-- A thread's issue, and the ts of the newest message in it handed on to the issue's session (slack.ts).
create table if not exists slack_threads (thread text primary key, slug text not null, read text);
-- The line for a checkout (land.ts): who waits for it, the branch each issue last tried there, and the branch desk
-- switched it to. repo is the checkout's folder.
create table if not exists line (
  repo text not null,
  place integer not null,
  slug text not null,
  branch text not null,
  holder text not null, -- test, the issue's session, or review, the user's Try
  primary key (repo, slug)
);
create table if not exists tries (repo text not null, slug text not null, branch text not null, primary key (repo, slug));
create table if not exists trying (
  repo text primary key,
  branch text not null,
  slug text not null,
  back text not null, -- the branch to put the checkout back on
  holder text,
  told boolean not null default false, -- whether its session knows the branch runs
  since double precision not null, -- seconds
  pid integer -- the desk that switched it
);
create table if not exists copies (path text primary key, text text); -- each file copies.ts last wrote out, null once removed
create table if not exists sessions ( -- what each session does, as the session host tells desk (turns.ts)
  id text primary key,
  open boolean not null default false, -- the host holds its process
  working boolean not null default false, -- a turn runs
  asks integer not null default 0, -- the questions waiting on the user: a tool to allow, AskUserQuestion's
  prompted timestamptz, -- when the user last wrote to it, or desk for them
  replied timestamptz, -- when its last turn ended with its reply
  ended timestamptz, -- when its last turn ended, however: its reply, Stop, an error, or its process going
  updated timestamptz not null default now()
);
create table if not exists inbox ( -- the Inbox's rows (inbox.ts): what each session last did for you, and each issue to settle
  id text primary key, -- the session's id, or the slug of an issue in Triage with no session
  slug text not null, -- what the row opens: the issue's slug, or the id of a chat with no issue
  issue boolean not null, -- whether slug names an issue
  session text,
  title text not null, -- as it was when written: the app shows an issue's own title
  agent text, -- the agent of a chat with no issue
  why text not null, -- what happened, as pages.ts names it
  says text not null, -- the row's second line, after who
  kind text not null, -- review: Go or Approve decides it; needs: anything else
  waits boolean not null, -- it stays listed, read or not, until answered: a question, a landing stuck, an issue to settle
  at double precision not null, -- when it happened, in seconds
  read double precision -- when you read it, in seconds; null while unread
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
  // The Inbox's delete and its mark as unread (inbox.ts), from 19 Oct.
  await opened.exec(["gone", "marked"].map((c) => `alter table inbox add column if not exists ${c} double precision;`).join(" "));
  await opened.exec("alter table slack_threads add column if not exists read text;");
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
let wrote: () => void = () => {};

// One at a time: each write, and each read of the log that must not see a write half told.
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// The one way to write a row: fn's queries run in one transaction, which every query of it must use, never sql(),
// whose query would wait for this transaction to end. Once it commits, what it logged is told (onWrite), and that it
// changed a row, of any table (onCommit). A write must not start another.
export function write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return locked(async () => {
    const [done, changed] = await sql().transaction(async (tx) => {
      const done = await fn(tx);
      // Postgres gives a transaction its id at its first write: none, and it changed nothing.
      return [done, (await tx.query<{ id: unknown }>("select txid_current_if_assigned() as id")).rows[0].id !== null] as const;
    });
    await told();
    if (changed) wrote();
    return done;
  });
}

// sync.ts hears here of each write's changes, with the change told before them.
export const onWrite = (fn: typeof tell) => { tell = fn; };

// And here of each write that changed a row, of a table the app holds or not, such as the line's or a session's: what
// the frame and the open chats show may have moved.
export const onCommit = (fn: () => void) => { wrote = fn; };

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
