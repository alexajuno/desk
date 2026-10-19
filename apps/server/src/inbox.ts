// The Inbox's rows, in the inbox table, which the app holds as it holds the issues (db.ts, HELD): one for each session
// that replied or asks you something, and one for each issue in Triage with no chat. "if we do it properly, this
// problem won't happen" (the user, 19 Oct, of the Inbox's count saying 2 over a list of one, then flipping back): the
// sidebar's count, the Inbox's list and each row's dot are all worked out in the app from these same rows, and no
// browser keeps its own idea of what was read.
//
// A row is written when something happens: a reply, a question, a landing stuck, an issue to settle (pages.ts says what
// each session's row says now, and take() writes what moved). Something new makes the row unread, unless you watch the
// session as it comes, or wrote to it since. Opening the row, or the session's chat, writes that you read it, through
// the one write path, so every tab hears it. A read row stays, as Linear's does, so the Inbox can list it, until you
// delete it (the Inbox's ⋯ menu and Backspace): it keeps its place, marked gone, until something newer brings it back,
// or a day passes. Linear keeps 2,000 notifications; so does desk, the newest, since the app holds every row (a day of
// them was 83 on 19 Oct, a week 221). A row the table never had that is a day old is no news, and stays out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";

export interface Row {
  id: string; // the session's id, or the slug of an issue in Triage with no session
  slug: string; // what the row opens: the issue's slug, or the id of a chat with no issue
  issue: boolean;
  session: string | null;
  title: string;
  agent: string | null;
  why: string;
  says: string;
  kind: "needs" | "review";
  waits: boolean; // listed, read or not, until answered
  at: number; // when it happened, in seconds
  read: number | null; // when you read it, in seconds
  gone: number | null; // when you deleted it: out of the Inbox until something newer comes
  marked: number | null; // when you marked it unread: it stays so, though you saw the session, until you read it
}

// What a row should say now, as pages.ts works it out. at is when it happened, or null for a question or a landing
// stuck, which happened when desk first saw it. looked is when you last saw the session: now while a panel shows it,
// else when you last wrote to it; a row that happened before it starts read. seed is the read it starts with when the
// table first fills.
export interface Want extends Omit<Row, "at" | "read" | "gone" | "marked"> {
  at: number | null;
  looked: number;
  seed: number | null;
}

const DAY = 86400; // seconds a deleted row is kept, and how old a row new to the table may be
const KEEP = 2000; // read rows kept, the newest: Linear's Inbox keeps 2,000 notifications (linear.app/docs/inbox)
const COLUMNS = ["id", "slug", "issue", "session", "title", "agent", "why", "says", "kind", "waits", "at", "read", "gone", "marked"] as const;

// The table, as desk last wrote it: desk is its one writer.
const rows = new Map<string, Row>();
let filled = false; // whether the table has filled once, from the Inbox's marks before it

export async function load() {
  for (const r of (await sql().query<Row>(`select ${COLUMNS.join(", ")} from inbox`)).rows) rows.set(r.id, r);
  filled = (await sql().query("select 1 from meta where name = 'inbox'")).rows.length > 0;
  if (filled) await readBack();
}

// What a desk of a branch from before the table read while Try ran it, as it kept it in seen.json: each unread row
// whose session it read since the row's news is read, as desk starts again on its own branch.
async function readBack() {
  const marks = before().sessions;
  const now = [...rows.values()].filter((r) => r.read === null && (marks[r.id] ?? 0) >= r.at);
  if (!now.length) return;
  await db.write(async (tx) => {
    for (const r of now) await tx.query("update inbox set read = $1 where id = $2", [marks[r.id], r.id]);
  });
  for (const r of now) rows.set(r.id, { ...r, read: marks[r.id] });
}

// --- reading -------------------------------------------------------------------------------------------------------

// Whether the table has yet to fill once: until then each row's read comes from the marks kept before it (seen).
export const filling = () => !filled;

// The rows the Inbox may list, newest first, read or not, but none you deleted, save the one open now (keep): its view
// picks among them (pages.ts).
export const shown = (keep = ""): Row[] => [...rows.values()].filter((r) => r.gone === null || r.slug === keep).sort((a, b) => b.at - a.at);

// The rows that ask for you, newest first, as /api/inbox lists them: each unread one, each that waits on you, and the
// one open now (keep).
export function listed(keep = ""): Row[] {
  return [...rows.values()].filter((r) => r.read === null || r.waits || r.slug === keep).sort((a, b) => b.at - a.at);
}

// Whether the session said something you have not read.
export const unread = (session: string) => rows.get(session)?.read === null;

export const unreadCount = () => [...rows.values()].filter((r) => r.read === null).length;

// When the user last read each session, before the table (seen.json, 19 Oct), and when that file began: read as the
// table first fills, and at each start for what a branch from before read meanwhile. desk writes the file no more; such
// a branch reads it still. Once no branch from before is left, reading it can go.
export function before(): { since: number; sessions: Record<string, number> } {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, "seen.json"), "utf8"));
  } catch {
    return { since: Date.now() / 1000, sessions: {} };
  }
}

// --- writing -------------------------------------------------------------------------------------------------------

const same = (a: Row, b: Row) => COLUMNS.every((c) => a[c] === b[c]);

async function put(tx: db.Db, r: Row) {
  await tx.query(`insert into inbox (${COLUMNS.join(", ")}) values (${COLUMNS.map((_, n) => `$${n + 1}`).join(", ")})
    on conflict (id) do update set ${COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`, COLUMNS.map((c) => r[c]));
}

// Write what each row says now, as one write: something new, a reply later than the row's, or a question or a landing
// stuck where it said something else, makes it unread unless you saw it come, and brings back a row you deleted; else
// it keeps its time, its read, its delete and its mark, and says what it says now, as when its issue moved. A row you
// marked unread stays unread though you saw the session. A row no longer wanted leaves, as a deleted one a day old, and
// the oldest read rows past KEEP; one the table never had that is a day old is no news, and stays out.
export function take(wanted: Want[]): Promise<void> {
  return db.write(async (tx) => {
    const now = Date.now() / 1000, next = new Map<string, Row>();
    for (const w of wanted) {
      const had = rows.get(w.id);
      const at = w.at ?? (had && had.why === w.why && had.waits === w.waits ? had.at : now);
      const fresh = !had || at > had.at;
      const seenIt = (when: number) => (w.looked >= when ? w.looked : null);
      const read = !filled ? w.seed : !had && at < now - DAY ? at : fresh ? seenIt(at) : had.read ?? (had.marked ? null : seenIt(had.at));
      const { looked: _l, seed: _s, ...shown } = w;
      const row: Row = { ...shown, at: fresh ? at : had.at, read, gone: fresh ? null : had.gone, marked: fresh ? null : had.marked };
      if (row.read !== null && !row.waits && row.at < now - DAY && (!had || row.gone !== null)) continue;
      next.set(row.id, row);
    }
    const old = [...next.values()].filter((r) => r.read !== null && !r.waits).sort((a, b) => b.at - a.at).slice(KEEP);
    for (const r of old) next.delete(r.id);
    for (const row of next.values()) {
      const had = rows.get(row.id);
      if (!had || !same(had, row)) await put(tx, row);
    }
    const gone = [...rows.keys()].filter((id) => !next.has(id));
    if (gone.length) await tx.query("delete from inbox where id = any($1)", [gone]);
    if (!filled) await tx.query("insert into meta values ('inbox', 'filled') on conflict do nothing");
    rows.clear();
    for (const [id, r] of next) rows.set(id, r);
    filled = true;
  });
}

// You read the rows that open this issue or chat, or the session's: now, unless already read.
export async function read(by: { slug: string } | { session: string }) {
  const [column, value] = "slug" in by ? ["slug", by.slug] : ["id", by.session];
  if (![...rows.values()].some((r) => r[column as "slug" | "id"] === value && r.read === null)) return;
  const done = await db.write((tx) => tx.query<Row>(`update inbox set read = $1, marked = null where ${column} = $2 and read is null
    returning ${COLUMNS.join(", ")}`, [Date.now() / 1000, value]));
  for (const r of done.rows) rows.set(r.id, r);
}

// The Inbox's ⋯ menu, U and Backspace, Linear's: the rows read, or unread again, or deleted. A deleted row is read
// too, so the count drops with it; a row that waits on you stays until you answer it.
export async function mark(act: "read" | "unread" | "delete", ids: string[]) {
  if (!ids.length) return 0;
  const set = { read: "read = coalesce(read, $1), marked = null", unread: "read = null, marked = $1",
    delete: "gone = $1, read = coalesce(read, $1), marked = null" }[act];
  const done = await db.write((tx) => tx.query<Row>(`update inbox set ${set} where id = any($2)${act === "delete" ? " and not waits" : ""}
    returning ${COLUMNS.join(", ")}`, [Date.now() / 1000, ids]));
  for (const r of done.rows) rows.set(r.id, r);
  return done.rows.length;
}
