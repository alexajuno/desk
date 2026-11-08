// desk's database: SQLite, built into Node (node:sqlite), in one file beside the data it holds, DB_FILE. Until 8 Nov it
// was Postgres, run in this process by PGlite (Postgres compiled to WebAssembly), which kept 128 MB of its own and took
// 210–390 MB more as it opened; SQLite, on the same reads, about 270 MB less (desk issue "Cut the desk server’s memory:
// PGlite alone takes about 470 MB", the user, 8 Nov: "proced"). PGlite's folder, DB_DIR, is read into the file once
// (fromPglite) and kept as it was.
//
// The code queries as it did on Postgres: query(text, params) with $1, $2, a list given for = any($1), true and false,
// and rows back with their lists and true or false. Here each is put as SQLite has it: $1 as ?1, = any($1) as in a JSON
// list's values, a list or an object as JSON text, true as 1; and a row's column declared json or boolean, back again.
//
// The center of desk's data ("what to be the center of data. which should be api and db", the user, 19 Oct): every
// write to a table the app holds goes through write() here, one at a time and in one transaction, and a trigger notes
// each row it changes in changed, in that same transaction, whoever writes: the API or desk itself. The write takes
// those rows as they stand before it commits, and sync.ts sends them to every open app once it has; an app back from
// a drop takes every row again. Reads go through sql().
//
// The tables are the record of desk's state ("you should find whatever represent state, should be in db", the user, 19
// Oct): issues, teams and projects, the Inbox, the trash, pins, each session's model, settings and the test desks.
// An issue, a team and a project live in their rows alone: no file holds a copy of them ("issue.md and team.md and
// whatever markdown files. to db", the user, 8 Nov).
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { DB_DIR, DB_FILE } from "./config.ts";

let db: DatabaseSync | null = null;

// What a query gives back: its rows, and how many rows a write without returning changed.
export interface Results<T> { rows: T[]; affectedRows: number }
// What a query can run on: the database, or a write's transaction, which every query of the write must use.
export interface Db {
  query<T = { [key: string]: any }>(text: string, params?: unknown[]): Promise<Results<T>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  exec(text: string): Promise<void>;
}

// The tables the app holds, each with its key, the columns it is not sent (a description stays on the server) and which
// rows it holds, when not all: a deleted issue is not the app's.
const HELD: Record<string, { key: string; hidden: string[]; live?: string }> = {
  issues: { key: "slug", hidden: ["body", "updated", "deleted_at"], live: "deleted_at is null" },
  teams: { key: "slug", hidden: ["body"] },
  projects: { key: "slug", hidden: ["body"] },
  milestones: { key: "id", hidden: [] },
  activity: { key: "id", hidden: [] },
  chats: { key: "id", hidden: ["folder", "cwd", "seen"] }, // threads: shown since 3 Nov, for Claude's draft on one (YourReply.tsx)
  inbox: { key: "id", hidden: [] },
  tabs: { key: "target", hidden: [] },
  replies: { key: "id", hidden: [] },
};

// A column declared json holds JSON text, given back parsed; one declared boolean holds 1 or 0, given back as true or
// false.
const SCHEMA = `
create table if not exists issues (
  slug text primary key,
  title text not null,
  priority text not null default 'none',
  state text not null default 'backlog',
  parent text,
  team text,
  project text, -- Linear's, since 20 Oct (projects.ts), as its team is what its project was before
  milestone text,
  due text, -- a day, 2026-11-08: its due date, Linear's
  folder text,
  link text,
  landing text,
  landed text,
  lands text, -- JSON: the steps Approve runs to land the work, which its session gave with its last report (land.ts, Lands)
  waiting_on text,
  waiting_since text,
  review_of text,
  review_since text,
  created text not null,
  body text not null default '',
  updated text, -- when it was last saved, in epoch seconds
  deleted_at text -- when its delete took it out of sight, as Laravel's soft delete (issues.ts, trash)
);
create table if not exists steps ( -- an issue's steps, one row each, which its session sets and ticks as it goes (steps.ts)
  id integer primary key,
  issue text not null,
  place text not null, -- its address in the list: 1.2, the first step's second
  title text not null,
  state text not null, -- todo, running or done
  note text,
  "commit" text, -- for a step that changes code, the commit that ends it
  base text, -- on the first step with a commit: where its branch left main
  body text -- what its session drew on it, its diagram and words, as Markdown
);
create index if not exists steps_issue on steps (issue);
create table if not exists teams ( -- teams.ts: desk's projects until 20 Oct
  slug text primary key,
  title text not null,
  state text not null default 'active',
  created text not null,
  aliases text not null default '', -- the slugs it had before a rename, space-separated, which still lead to it
  body text not null default ''
);
create table if not exists projects ( -- projects.ts: Linear's, which finish, since 20 Oct
  slug text primary key,
  title text not null,
  team text,
  status text not null default 'backlog',
  start text,
  target text,
  created text not null,
  body text not null default ''
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
  threads json, -- the Slack threads, DMs and mail threads it follows (chats.ts, follow)
  unsubscribed json, -- those whose new messages wait rather than wake it (chats.ts, setSubscribed)
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
  seq integer not null -- the order they were pinned in
);
create table if not exists session_models ( -- the model and effort picked for a session (models.ts)
  session text primary key,
  model text,
  effort text
);
create table if not exists settings (name text primary key, value json not null); -- each one set (settings.ts)
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
  prompted double precision, -- when the user last wrote to it, or desk for them, in seconds
  replied double precision, -- when its last turn ended with its reply
  ended double precision, -- when its last turn ended, however: its reply, Stop, an error, or its process going
  cost double precision, -- the dollars it has spent so far, as Claude Code counts them on each turn's result
  tokens double precision, -- the tokens its model calls read so far, fresh or from the cache
  context_tokens double precision, -- how full its context is, as Claude Code last counted it (models.ts)
  context_max double precision, -- out of how many
  context_at double precision, -- when it counted, in seconds
  updated double precision not null -- when desk last wrote it
);
create table if not exists session_text ( -- what a search finds a session by: what the menu shows of it, and every prompt
  id integer primary key, -- its row in session_find
  session text not null unique,
  title text not null default '', -- its title, its issue's slug and title, and its folder, as the menu shows them
  prompts text not null default '', -- every prompt typed in it, one a line
  read_to integer not null default 0 -- how far its transcript was read for them
);
-- The full-text index over each session's title and prompts, folded (sessiontext.ts, fold), under session_text's id. It
-- holds no copy of the text, only the index, from which a row can be deleted.
create virtual table if not exists session_find using fts5(words, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2');
create table if not exists session_words (word text primary key); -- each word of session_text once, for a typo's near words
create table if not exists search_log ( -- each time the search's box opened: what was typed and what it opened (searchlog.ts)
  at double precision not null, -- in seconds
  tab text not null default '', -- the kind it ended on, '' for All
  query text not null default '',
  picked_kind text, -- chat, issue, ...: null when it closed with nothing opened
  picked text, -- its key
  picked_title text,
  picked_from text, -- browser, a title found on the key, or server, found later
  rank integer, -- its place in the list, from 0
  took_ms integer not null, -- from the box opening to that
  keys integer not null default 0, -- changes to what was typed
  server_ms integer -- how long the server took on the last search it answered
);
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
  why text not null default '', -- the firewall's line, the chat's, or a mail's topic
  chat text, -- the chat it went to rather than the firewall
  wake text -- the wake that carried it to the chat (wakes.ts)
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
  read double precision, -- when you read it, in seconds; null while unread
  gone double precision, -- when you deleted it
  marked double precision, -- when you marked it unread
  source text, -- a Slack thread's or a mail thread's row (notices.ts): where it came from
  who text -- and who wrote last
);
create table if not exists meta (name text primary key, value text not null); -- what desk notes of itself, by name
-- The rows a write changed, each by its table and key, noted by the triggers below in the write's transaction and taken
-- out again before it commits (write): the push then sends those rows as they stand. Empty between writes.
create table if not exists changed (kind text not null, key text not null, primary key (kind, key));
`;

// Each table the app holds notes the rows a write changes, by their key: a row whose key changed, under both. An update
// that changes nothing, as a save of what the row already holds, notes nothing.
function triggers(d: DatabaseSync): string {
  return Object.entries(HELD).map(([table, { key }]) => {
    const columns = d.prepare(`select name from pragma_table_info('${table}')`).all().map((c) => `"${c.name as string}"`);
    // Not insert or ignore: in a trigger, the conflict rule of the statement that fired it overrides the trigger's own.
    const note = (row: "old" | "new") =>
      `insert into changed select '${table}', ${row}.${key} where not exists (select 1 from changed where kind = '${table}' and key = ${row}.${key});`;
    return `drop trigger if exists ${table}_noted; drop trigger if exists ${table}_gone; drop trigger if exists ${table}_changed;
create trigger ${table}_noted after insert on ${table} begin ${note("new")} end;
create trigger ${table}_gone after delete on ${table} begin ${note("old")} end;
create trigger ${table}_changed after update on ${table} when ${columns.map((c) => `old.${c} is not new.${c}`).join(" or ")}
  begin ${note("old")} ${note("new")} end;`;
  }).join("\n");
}

export async function open(): Promise<Db> {
  if (db) return outside;
  mkdirSync(dirname(DB_FILE), { recursive: true });
  // The data folder is a git repo of its own, for the issues: the database stays out of it.
  const ignore = join(dirname(DB_FILE), ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  if (!existsSync(DB_FILE)) await made();
  const opened = new DatabaseSync(DB_FILE);
  // A write waits on the disk only at checkpoints, and a read never waits on a write; like matches case, as Postgres's.
  opened.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000; pragma case_sensitive_like = true;");
  opened.exec(SCHEMA);
  opened.exec(triggers(opened));
  opened.exec("delete from changed;"); // what a write cut short by a crash noted
  db = opened;
  return outside;
}

// The file, made whole before it takes its name, so that a start cut short makes it again: a test desk's from the copy
// its pool made (pool.ts, copy), else 8790's from PGlite's folder, or empty.
async function made() {
  const from = process.env.DESK_DB_FROM;
  if (from && isSqlite(from)) return copyFileSync(from, DB_FILE);
  const next = `${DB_FILE}.new`;
  rmSync(next, { force: true });
  const d = new DatabaseSync(next);
  d.exec(SCHEMA);
  const moved = from ? await fromPglite(d, { dump: from }) : existsSync(join(DB_DIR, "PG_VERSION")) ? await fromPglite(d, { dir: DB_DIR }) : 0;
  d.close();
  renameSync(next, DB_FILE);
  if (moved) console.log(`desk moved ${moved} rows from PGlite into ${DB_FILE}`);
}

const isSqlite = (path: string) => {
  const head = Buffer.alloc(16), fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  return head.toString("latin1") === "SQLite format 3\0";
};

// Every row of every table both have, from PGlite's folder, or from a dump of it that a test desk's pool made before
// 8 Nov, in one transaction. Postgres's lists and JSON come as JSON text, its true and false as 1 and 0.
async function fromPglite(d: DatabaseSync, source: { dir: string } | { dump: string }): Promise<number> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { unaccent } = await import("@electric-sql/pglite/contrib/unaccent");
  const { readFileSync } = await import("node:fs");
  const pg = "dir" in source
    ? await PGlite.create(source.dir, { extensions: { pg_trgm, unaccent } })
    : await PGlite.create({ extensions: { pg_trgm, unaccent }, loadDataDir: new Blob([readFileSync(source.dump)]) });
  let n = 0;
  d.exec("begin");
  for (const { name: table } of d.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]) {
    const mine = d.prepare(`select name from pragma_table_info('${table}')`).all().map((c) => c.name as string);
    const theirs = new Set((await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = $1", [table])).rows.map((r) => r.column_name));
    const both = mine.filter((c) => theirs.has(c));
    if (!both.length) continue;
    const insert = d.prepare(`insert into ${table} (${both.map((c) => `"${c}"`).join(", ")}) values (${both.map(() => "?").join(", ")})`);
    const order = table === "pins" ? " order by seq" : "";
    for (const row of (await pg.query<Record<string, unknown>>(`select ${both.map((c) => `"${c}"`).join(", ")} from ${table}${order}`)).rows) {
      insert.run(...both.map((c) => bind(row[c])));
      n++;
    }
  }
  d.exec("commit");
  await pg.close();
  return n;
}

// --- querying ----------------------------------------------------------------------------------------------------------

// A value as SQLite takes it: a list or an object as JSON text, true and false as 1 and 0, a date as ISO text.
function bind(v: unknown): null | number | bigint | string | NodeJS.ArrayBufferView {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (ArrayBuffer.isView(v)) return v as NodeJS.ArrayBufferView;
  return JSON.stringify(v);
}

// A statement as desk wrote it for Postgres, put as SQLite reads it, prepared once: $1 as ?1, and = any($1), which
// Postgres reads with a list, as in that list's values, which come as JSON text.
interface Prepared { statement: StatementSync; reads: boolean; kinds: [string, "json" | "boolean"][] }
const prepared = new Map<string, Prepared>();
function prepare(text: string): Prepared {
  let p = prepared.get(text);
  if (!p) {
    const statement = database().prepare(text.replace(/=\s*any\(\$(\d+)\)/gi, "in (select value from json_each(?$1))").replace(/\$(\d+)/g, "?$1"));
    const columns = statement.columns();
    const kinds = columns.flatMap((c): [string, "json" | "boolean"][] => {
      const type = c.type?.toLowerCase();
      return type === "json" || type === "boolean" ? [[c.name, type]] : [];
    });
    p = { statement, reads: columns.length > 0, kinds };
    prepared.set(text, p);
  }
  return p;
}

function run<T>(text: string, params: unknown[] = []): Results<T> {
  const { statement, reads, kinds } = prepare(text);
  const values = params.map(bind);
  if (!reads) return { rows: [], affectedRows: Number(statement.run(...values).changes) };
  const rows = statement.all(...values).map((r) => {
    const row: Record<string, unknown> = { ...r };
    for (const [name, kind] of kinds) {
      const v = row[name];
      if (v === null || v === undefined) continue;
      if (kind === "boolean") row[name] = v === 1 || v === 1n || v === true;
      else if (typeof v === "string") {
        try {
          row[name] = JSON.parse(v);
        } catch {
          // left as the text it is
        }
      }
    }
    return row as T;
  });
  return { rows, affectedRows: rows.length };
}

function database(): DatabaseSync {
  if (!db) throw new Error("The database is not open yet.");
  return db;
}

// A write's transaction, while one is open: a query from outside it waits for it to end, as on PGlite, so that no read
// sees a write half done and no write joins one that may yet roll back.
let busy: Promise<void> | null = null;
const waited = async () => {
  while (busy) await busy;
};
const outside: Db = {
  query: async (text, params) => (await waited(), run(text, params)),
  exec: async (text) => (await waited(), database().exec(text)),
};
const inside: Db = {
  query: async (text, params) => run(text, params),
  exec: async (text) => database().exec(text),
};

export function sql(): Db {
  database();
  return outside;
}

// A whole copy of the database, consistent as of now, for a test desk's pool (pool.ts, copy).
export async function copyTo(path: string) {
  await waited();
  rmSync(path, { force: true });
  database().prepare("vacuum into ?").run(path);
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
export const write = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => transaction(fn, true);

// A write to tables no app holds and no frame shows, as the session search's: one transaction, as write's, telling no one.
export const quietly = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => transaction(fn, false);

function transaction<T>(fn: (tx: Db) => Promise<T>, told: boolean): Promise<T> {
  return locked(async () => {
    await waited();
    const d = database();
    let end = () => {};
    busy = new Promise<void>((done) => (end = done));
    try {
      d.exec("begin immediate");
      const before = changes(d);
      const done = await fn(inside);
      const changed = told && changes(d) !== before;
      const rows = changed ? taken() : [];
      d.exec("commit");
      for (const kind of new Set(rows.map((r) => r.kind))) written.set(kind, writesTo(kind) + 1);
      if (rows.length) {
        const after = pushed;
        tell(rows.map((c) => ({ ...c, seq: ++pushed })), after);
      }
      if (changed) wrote();
      return done;
    } catch (error) {
      if (d.isTransaction) d.exec("rollback");
      throw error;
    } finally {
      busy = null;
      end();
    }
  });
}

// How many writes have changed rows of each table the app holds: a reader that keeps a copy of a table reads it again
// once its count moves (issues.ts, shown).
const written = new Map<string, number>();
export const writesTo = (table: string) => written.get(table) ?? 0;

// How many rows this connection's statements have changed since it opened.
const changes = (d: DatabaseSync) => Number((d.prepare("select total_changes() as n").get() as { n: number }).n);

// sync.ts hears here of each write's changes, with the change told before them.
export const onWrite = (fn: typeof tell) => { tell = fn; };

// And here of each write that changed a row, of a table the app holds or not, such as the test desks' or a session's: what
// the frame and the open chats show may have moved.
export const onCommit = (fn: () => void) => { wrote = fn; };

// The columns of the table the app is sent, and its rows as the app holds them.
const shown = (table: string) =>
  database().prepare(`select name from pragma_table_info('${table}')`).all().map((c) => c.name as string)
    .filter((c) => !HELD[table].hidden.includes(c)).map((c) => `"${c}"`).join(", ");

// The rows a write noted (changed, above), as they stand at its end, in its transaction: each table's own, or null for
// a row it deleted. Taken out, so that the table is empty again once the write commits.
function taken(): Omit<Change, "seq">[] {
  const noted = run<{ kind: string; key: string }>("delete from changed returning kind, key").rows;
  const rows: Omit<Change, "seq">[] = [];
  for (const [table, { key, live }] of Object.entries(HELD)) {
    const keys = noted.filter((n) => n.kind === table).map((n) => n.key);
    if (!keys.length) continue;
    const found = run<Record<string, unknown>>(`select ${shown(table)} from ${table} where ${key} = any($1)${live ? ` and ${live}` : ""}`, [keys]);
    const by = new Map(found.rows.map((r) => [String(r[key]), r]));
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
  await waited();
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [table, { key, live }] of Object.entries(HELD))
    rows[table] = run<Record<string, unknown>>(`select ${shown(table)} from ${table}${live ? ` where ${live}` : ""} order by ${key}`).rows;
  return { log: LOG, seq: pushed, rows };
}

// What an app back from a drop missed: nothing, when it holds every change told in this run; null otherwise, and it
// takes every row afresh, since desk keeps no copy of what it told (3.3 MB for every row, on 8 Nov). Under locked, as
// snapshot.
export async function since(log: string, seq: number): Promise<Change[] | null> {
  return log === LOG && seq === pushed ? [] : null;
}

export async function close() {
  db?.close();
  db = null;
  prepared.clear();
}
