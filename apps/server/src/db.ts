// desk's database: Postgres, run inside this process by PGlite (PostgreSQL compiled to WebAssembly), so desk stays one
// process with no service of its own to start (the plan of "desk on Linear's stack": "Postgres holds the issues", and
// "One process, as now; no new services"). Its data lives in DB_DIR. A server Postgres can take its place later: the
// queries here are plain SQL.
//
// The center of desk's data ("what to be the center of data. which should be api and db", the user, 19 Oct): every
// write to a table the app holds goes through write() here, one at a time and in one transaction, and a trigger notes
// each row it changes in changed, in that same transaction, whoever writes: the API or desk itself. The write takes
// those rows as they stand before it commits, and sync.ts sends them to every open app once it has; an app back from
// a drop takes every row again. Reads go through sql().
//
// The tables are the record of desk's state ("you should find whatever represent state, should be in db", the user, 19
// Oct): issues, teams and projects, the Inbox, the trash, pins, each session's model, settings and the test desks.
// issue.md, team.md and project.md are only written out, for agents, git and an editor to read; desk reads them in only
// into a database with no issues yet, as a new one (issues.importAll).
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_DIR } from "./config.ts";

let db: PGlite | null = null;

// What a query can run on: the database, or a write's transaction, which every query of the write must use.
export type Db = Pick<Transaction, "query">;

// The tables the app holds, each with its key, the columns it is not sent (a description, and the text desk last
// wrote, stay on the server) and which rows it holds, when not all: a deleted issue is not the app's.
const HELD: Record<string, { key: string; hidden: string[]; live?: string }> = {
  issues: { key: "slug", hidden: ["body", "written", "session", "deleted_at"], live: "deleted_at is null" }, // session: unread since 29 Oct (chats.issue)
  teams: { key: "slug", hidden: ["body", "written"] },
  projects: { key: "slug", hidden: ["body", "written"] },
  milestones: { key: "id", hidden: [] },
  activity: { key: "id", hidden: [] },
  chats: { key: "id", hidden: ["folder", "cwd", "seen"] }, // threads: shown since 3 Nov, for Claude's draft on one (YourReply.tsx)
  inbox: { key: "id", hidden: [] },
  tabs: { key: "target", hidden: [] },
  replies: { key: "id", hidden: [] },
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
  team text,
  project text,
  milestone text,
  due text, -- a day, 2026-11-08: its due date, Linear's
  folder text,
  link text,
  landing text,
  landed text,
  lands text, -- JSON: the steps Approve runs to land the work, which its session gave with its last report (land.ts, Lands)
  plan_steps text, -- JSON: its steps, which its session sets and ticks as it goes (api.ts, PlanStep)
  session text, -- unread since 29 Oct: an issue's chat holds its session (chats.issue)
  waiting_on text,
  waiting_since text,
  review_of text,
  review_since text,
  created text not null,
  body text not null default '',
  written text -- issue.md as desk last wrote it, which tells an editor's change from desk's own
);
create table if not exists teams ( -- teams.ts: desk's projects until 20 Oct
  slug text primary key,
  title text not null,
  state text not null default 'active',
  created text not null,
  aliases text not null default '', -- the slugs it had before a rename, space-separated, which still lead to it
  body text not null default '',
  written text
);
create table if not exists projects ( -- projects.ts: Linear's, which finish, since 20 Oct
  slug text primary key,
  title text not null,
  team text,
  status text not null default 'backlog',
  start text,
  target text,
  created text not null,
  body text not null default '',
  written text
);
create table if not exists milestones ( -- projects.ts: a project's stages, Linear's, in the order of sort
  id text primary key,
  project text not null,
  title text not null,
  body text not null default '',
  target text, -- a period (periods.ts)
  sort double precision not null,
  created text not null
);
create table if not exists activity ( -- updates.ts: each project's updates, its draft, and the changes to it
  id text primary key,
  project text not null,
  kind text not null, -- update, draft or change
  health text,
  body text not null default '',
  field text,
  was text,
  now text,
  progress integer,
  at text not null
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
  auto boolean not null default false, -- Auto in its composer: desk says next for the user as a turn ends (auto.ts)
  named text,
  "from" text,
  automation text,
  threads text[], -- the Slack threads, DMs and mail threads it follows (chats.ts, follow)
  unsubscribed text[], -- those whose new messages wait rather than wake it (chats.ts, setSubscribed)
  seen double precision,
  deleted text -- when the user deleted it: out of sight, its row and transcript kept
);
create table if not exists tabs ( -- each tab a desk session has open in the agents' Chrome, as the host's relay tells it (tabs.ts)
  target text primary key, -- Chrome's id for it
  session text not null, -- the session that opened it, or the tab that opened it
  url text not null default '',
  title text not null default '',
  opened text not null -- when desk first heard of it
);
create table if not exists automations ( -- what happened to each of automations/*.md, which hold the rest (automations.ts)
  slug text primary key,
  seen text not null,
  fired text,
  chat text,
  ran text,
  note text not null default ''
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
-- What Claude Code last said of what the model chip's menu shows (models.ts): its models, the plan's usage, and each
-- session's context, as "context:<session>".
create table if not exists heard (name text primary key, value jsonb not null, at double precision not null);
create table if not exists settings (name text primary key, value jsonb not null); -- each one set (settings.ts)
-- The pool of test desks (pool.ts): each issue whose session asked for one, in the order it asked, with the port of
-- its slot once it has one (null while it waits in line), and when it was told so (null until then).
create table if not exists tests (
  slug text primary key,
  branch text not null,
  asked double precision not null, -- seconds
  port integer,
  told double precision -- seconds
);
create table if not exists sessions ( -- what each session does, as the session host tells desk (turns.ts)
  id text primary key,
  open boolean not null default false, -- the host holds its process
  working boolean not null default false, -- a turn runs
  asks integer not null default 0, -- the questions waiting on the user: a tool to allow, AskUserQuestion's
  prompted timestamptz, -- when the user last wrote to it, or desk for them
  replied timestamptz, -- when its last turn ended with its reply
  ended timestamptz, -- when its last turn ended, however: its reply, Stop, an error, or its process going
  cost double precision, -- the dollars it has spent so far, as Claude Code counts them on each turn's result
  tokens double precision, -- the tokens its model calls read so far, fresh or from the cache
  updated timestamptz not null default now()
);
-- The Sessions menu's search (sessiontext.ts). desk_words reads a text as simple does, its words whole and lowercased,
-- and folds their accents first, so that "cam giac" finds "cảm giác".
create extension if not exists pg_trgm;
create extension if not exists unaccent;
do $$ begin
  if not exists (select 1 from pg_ts_config where cfgname = 'desk_words') then
    create text search configuration desk_words (copy = simple);
    alter text search configuration desk_words alter mapping for asciiword, word, numword, asciihword, hword, numhword,
      hword_asciipart, hword_part, hword_numpart with unaccent, simple;
  end if;
end $$;
create table if not exists session_text ( -- what a search finds a session by: what the menu shows of it, and every prompt
  session text primary key,
  title text not null default '', -- its title, its issue's slug and title, and its folder, as the menu shows them
  prompts text not null default '', -- every prompt typed in it, one a line
  read_to bigint not null default 0, -- how far its transcript was read for them
  words tsvector generated always as (to_tsvector('desk_words', title || ' ' || prompts)) stored
);
create index if not exists session_text_words on session_text using gin (words);
create table if not exists search_log ( -- each time the search's box opened: what was typed and what it opened (searchlog.ts)
  at timestamptz not null default now(),
  tab text not null default '', -- the kind it ended on, '' for All
  query text not null default '',
  picked_kind text, -- chat, issue, ...: null when it closed with nothing opened
  picked text, -- its key
  picked_title text,
  picked_from text, -- browser, a title found on the key, or server, found later
  rank int, -- its place in the list, from 0
  took_ms int not null, -- from the box opening to that
  keys int not null default 0, -- changes to what was typed
  server_ms int -- how long the server took on the last search it answered
);
create table if not exists session_words (word text primary key); -- each word of session_text once, for a typo's near words
create index if not exists session_words_near on session_words using gin (word gin_trgm_ops);
create table if not exists notices ( -- each Slack message and mail that came in, and the firewall's verdict (notices.ts)
  id text primary key, -- slack:<channel>:<ts>, or mail:<Gmail's id>
  source text not null, -- slack or mail
  thread text not null, -- its DM, Slack thread or mail thread: one Inbox row each
  place text not null, -- #imagenhub, a DM, a group DM, mail
  who text not null, -- who sent it
  text text not null, -- the message; a mail's subject and start
  link text not null default '', -- opens it in Slack or Gmail
  at double precision not null, -- when it was sent, in seconds
  verdict text, -- now, later or dropped, or noted by a chat; null until the firewall, or the chat following it, judged it
  why text not null default '' -- the firewall's line, the chat's, or a mail's topic
);
create index if not exists notices_thread on notices (thread, at);
create table if not exists chat_picks ( -- what Haiku picked as each chat started (pick.ts)
  session text primary key,
  at double precision not null, -- in seconds
  rule text, -- A to D, null when it failed or timed out and the chat started on Preferences
  model text not null, -- what the chat started on
  effort text not null,
  why text not null default '', -- Haiku's few words
  ms integer not null, -- how long the first message waited on it
  cost double precision -- its dollars, at list price
);
create table if not exists wakes ( -- each time a thread's new messages woke the chat following it (wakes.ts)
  id text primary key, -- wake-<random>
  chat text not null, -- the chat it woke, by id
  session text not null, -- that chat's session then
  thread text not null, -- the thread its messages came in, as notices.thread
  messages integer not null, -- how many it carried
  at double precision not null, -- when desk gave them to the chat, in seconds
  before double precision, -- the chat's own last word to the user then, which its row keeps through the wake's turn
  verdict text, -- now, later or noted: the chat's call, later when its turn ended with none; null until then
  why text not null default '', -- the chat's line for the row
  answered double precision, -- when the verdict came, in seconds: the row's time for a now or a later
  error text not null default '', -- why desk could not give it to the chat
  spent double precision, -- the dollars the chat's session had spent before it, as Claude Code counts them
  spent_tokens double precision, -- and the tokens it had read
  cost double precision, -- the dollars its turn cost; null until its turn ended, or when no host heard what it cost
  tokens double precision, -- the tokens its turn read, fresh or from the cache
  gate text, -- the gate's answer on its messages, in the shadow: wake, skip, or failed (which wakes); null until it came (gate.ts)
  gate_why text not null default '', -- the gate's why, in a few words
  gate_cost double precision, -- the dollars its check cost
  gate_ms double precision -- how long its check took, in milliseconds
);
create index if not exists wakes_session on wakes (session, at);
create table if not exists replies ( -- each reply to a thread as the user (replies.ts): Claude's draft, then what the user's Send posted
  id text primary key, -- reply-<random>
  thread text not null, -- the Slack thread, DM or mail thread it answers, as notices.thread
  source text not null, -- slack or mail
  text text not null, -- what goes out, as the user left it on the card or wrote it in their box
  whom text not null default '', -- where it goes, as the card says: in #imagenhub, in minhnt's thread; to Talent team <talent@…>
  state text not null, -- draft, sending, sent, failed, or kept: a test desk sends nothing
  at double precision not null, -- when Claude drafted it, or the user wrote it in their box, in seconds
  sent double precision, -- when it went
  link text not null default '', -- opens it in Slack or Gmail, once sent
  error text not null default '' -- why Slack or Gmail refused it
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
create table if not exists meta (name text primary key, value text not null); -- what desk notes of itself, by name
-- The rows a write changed, each by its table and key, noted by the triggers below in the write's transaction and taken
-- out again before it commits (write): the push then sends those rows as they stand. Empty between writes.
create table if not exists changed (kind text not null, key text not null, primary key (kind, key));
-- Notes the row a write changed, under its key, the trigger's one argument; a row whose key changed, under both.
create or replace function noted() returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    insert into changed values (tg_table_name, to_jsonb(old) ->> tg_argv[0]) on conflict do nothing;
  end if;
  if tg_op <> 'DELETE' then
    insert into changed values (tg_table_name, to_jsonb(new) ->> tg_argv[0]) on conflict do nothing;
  end if;
  return null;
end $$;
${Object.entries(HELD).map(([table, { key }]) => {
  // An update that changes nothing, as a save of what the row already holds, notes nothing.
  return `drop trigger if exists ${table}_logged on ${table}; drop trigger if exists ${table}_updated on ${table};
create or replace trigger ${table}_noted after insert or delete on ${table} for each row execute function noted('${key}');
create or replace trigger ${table}_changed after update on ${table} for each row when (old is distinct from new) execute function noted('${key}');`;
}).join("\n")}`;

export async function open(): Promise<PGlite> {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  // The data folder is a git repo of its own, for the issues: the database stays out of it.
  const ignore = join(dirname(DB_DIR), ".gitignore");
  if (!process.env.DESK_DB && !existsSync(ignore)) writeFileSync(ignore, "*\n");
  // A test desk starts on a dump of 8790's database (pool.ts, copy), loaded once into its new folder.
  const from = process.env.DESK_DB_FROM && !existsSync(join(DB_DIR, "PG_VERSION")) ? process.env.DESK_DB_FROM : null;
  const opened = await PGlite.create(DB_DIR, {
    extensions: { pg_trgm, unaccent }, ...(from ? { loadDataDir: new Blob([readFileSync(from)]) } : {}),
  });
  await toTeams(opened);
  await opened.exec(SCHEMA);
  // Since 20 Oct, an issue's project is Linear's (projects.ts), as its team is what its project was before. An issue's
  // delete marks it, deleted_at, since 8 Nov (issues.ts, trash).
  await opened.exec(["review_of", "review_since", "landed", "project", "milestone", "due", "lands", "plan_steps", "deleted_at"].map((c) => `alter table issues add column if not exists ${c} text;`).join(" "));
  // The Inbox's delete and its mark as unread (inbox.ts), from 19 Oct.
  await opened.exec(["gone", "marked"].map((c) => `alter table inbox add column if not exists ${c} double precision;`).join(" "));
  // A Slack thread's or a mail thread's row (notices.ts): where it came from and who wrote last, from 2 Nov.
  await opened.exec(["source", "who"].map((c) => `alter table inbox add column if not exists ${c} text;`).join(" "));
  await opened.exec("alter table chats add column if not exists deleted text;"); // a chat's Delete (chats.ts, remove), from 25 Oct
  await opened.exec("alter table chats add column if not exists auto boolean not null default false;"); // its composer's Auto (chats.ts, setAuto), from 29 Oct
  // A chat's fields with no column of their own went into extra until 8 Nov, as JSON, what its file held before the
  // table (19 Oct) among them: the copies of its messages, all left unread. Its Delete's Undo learns from the delete
  // which Triage issue to take back (chats.ts, remove), rather than from extra.
  await opened.exec("alter table chats drop column if exists extra;");
  // What each session has spent so far, as its host hears it (turns.ts), from 3 Nov
  await opened.exec(["cost", "tokens"].map((c) => `alter table sessions add column if not exists ${c} double precision;`).join(" "));
  await opened.exec("alter table chats add column if not exists threads text[];"); // the threads it follows (chats.ts, follow), from 3 Nov
  await opened.exec("alter table chats add column if not exists unsubscribed text[];"); // those that wake nothing (chats.ts, setSubscribed), from 5 Nov
  // The chat a notice went to rather than the firewall, and the wake that carried it to the chat (wakes.ts), from 3 Nov
  await opened.exec(["chat", "wake"].map((c) => `alter table notices add column if not exists ${c} text;`).join(" "));
  await opened.exec("alter table teams add column if not exists aliases text not null default '';"); // a team's rename (teams.ts), from 25 Oct
  await opened.exec("drop table if exists slack_filed; drop table if exists slack_threads;"); // Slack's tags, out since 22 Oct
  // Try's line for desk's own checkout and the copies of the files from before 19 Oct, out since 2 Nov: a branch is
  // tested on a test desk of its own (pool.ts, tests).
  await opened.exec("drop table if exists line; drop table if exists tries; drop table if exists trying; drop table if exists copies;");
  // The log of changes, a copy of each row a write changed, numbered, which an app back from a drop caught up from, out
  // since 8 Nov: such an app takes every row again (3.3 MB on 8 Nov), and the changed rows go out as they stand.
  await opened.exec("drop table if exists changes; drop function if exists logged(); delete from meta where name in ('log', 'pruned');");
  await opened.exec("delete from changed;"); // what a write cut short by a crash noted
  await opened.exec("alter table issues drop column if exists protocol;"); // an issue's protocol, out since 4 Nov
  // desk's database is a few MB: Postgres's default 128 MB of shared buffers only holds memory, about 50 MB of it. Set
  // once in postgresql.auto.conf, it applies from the next start.
  if ((await opened.query<{ shared_buffers: string }>("show shared_buffers")).rows[0]?.shared_buffers !== "16MB")
    await opened.exec("alter system set shared_buffers = '16MB'");
  db = opened;
  return opened;
}

// desk's projects became teams on 20 Oct (teams.ts), so that a project can be Linear's, one that finishes: their table,
// each issue's project and each trashed issue's, move over once, before the schema makes the tables it lacks.
async function toTeams(pg: PGlite) {
  const has = async (table: string) => (await pg.query("select 1 from information_schema.tables where table_name = $1", [table])).rows.length > 0;
  if (!(await has("projects")) || (await has("teams"))) return;
  await pg.transaction(async (tx) => {
    await tx.exec(`drop trigger if exists projects_logged on projects;
      drop trigger if exists projects_updated on projects;
      alter table projects rename to teams;
      alter table issues rename column project to team;`);
  });
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
let pushed = 0; // the newest change told to the apps in this run
let tell: (changes: Change[], after: number) => void = () => {};
let wrote: () => void = () => {};

// One at a time: each write, and each read of the log that must not see a write half told.
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// The one way to write a row: fn's queries run in one transaction, which every query of it must use, never sql(),
// whose query would wait for this transaction to end. Once it commits, the rows it noted are told (onWrite), and that it
// changed a row, of any table (onCommit). A write must not start another.
export function write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return locked(async () => {
    const [done, changed, rows] = await sql().transaction(async (tx) => {
      const done = await fn(tx);
      // Postgres gives a transaction its id at its first write: none, and it changed nothing.
      const changed = (await tx.query<{ id: unknown }>("select txid_current_if_assigned() as id")).rows[0].id !== null;
      return [done, changed, changed ? await taken(tx) : []] as const;
    });
    if (rows.length) {
      const after = pushed;
      tell(rows.map((c) => ({ ...c, seq: ++pushed })), after);
    }
    if (changed) wrote();
    return done;
  });
}

// sync.ts hears here of each write's changes, with the change told before them.
export const onWrite = (fn: typeof tell) => { tell = fn; };

// And here of each write that changed a row, of a table the app holds or not, such as the test desks' or a session's: what
// the frame and the open chats show may have moved.
export const onCommit = (fn: () => void) => { wrote = fn; };

// The rows a write noted (changed, above), as they stand at its end, in its transaction: each table's own, or null for
// a row it deleted. Taken out, so that the table is empty again once the write commits.
async function taken(tx: Db): Promise<Omit<Change, "seq">[]> {
  const noted = (await tx.query<{ kind: string; key: string }>("delete from changed returning kind, key")).rows;
  const rows: Omit<Change, "seq">[] = [];
  for (const [table, { key, live }] of Object.entries(HELD)) {
    const keys = noted.filter((n) => n.kind === table).map((n) => n.key);
    if (!keys.length) continue;
    const found = await tx.query<{ key: string; row: Record<string, unknown> }>(
      `select ${key} as key, ${shown(table)} as row from ${table} t where ${key} = any($1)${live ? ` and ${live}` : ""}`, [keys]);
    const by = new Map(found.rows.map((r) => [r.key, r.row]));
    for (const k of keys) rows.push({ kind: table, key: k, row: by.get(k) ?? null });
  }
  return rows;
}

// --- what an app is sent ------------------------------------------------------------------------------------------------

// This run's name for its numbering of changes, which starts again at each start: an app that names another run's, as
// after a restart, takes every row afresh.
const LOG = randomUUID();

// Every row the app holds, by table, with the run's name and the newest change in them. Under locked, so no write
// lands between it and the changes told after it.
export async function snapshot(): Promise<{ log: string; seq: number; rows: Record<string, Record<string, unknown>[]> }> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [table, { key, live }] of Object.entries(HELD))
    rows[table] = (await sql().query<{ row: Record<string, unknown> }>(`select ${shown(table)} as row from ${table} t${live ? ` where ${live}` : ""} order by ${key} collate "C"`)).rows.map((r) => r.row);
  return { log: LOG, seq: pushed, rows };
}

// What an app back from a drop missed: nothing, when it holds every change told in this run; null otherwise, and it
// takes every row afresh, since desk keeps no copy of what it told (3.3 MB for every row, on 8 Nov). Under locked, as
// snapshot.
export async function since(log: string, seq: number): Promise<Change[] | null> {
  return log === LOG && seq === pushed ? [] : null;
}

export async function close() {
  await db?.close();
  db = null;
}
