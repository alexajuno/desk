// What each session does now, as the session host tells desk: whether the host holds its process, whether a turn runs,
// how many questions wait on the user, when the user last wrote to it and when it last replied. "when agent changes
// sth, it calls api, not edit file and desk fetches from file later" (the user, 19 Oct): the host (host.ts) keeps a
// WebSocket open to desk's /api/host and says each change on it the moment it happens, and desk keeps it in the
// sessions table, which the Inbox, the sidebar and the issues' moves read (pages.ts), rather than Claude Code's
// transcripts and `claude agents`, asked again every 5 s.
//
//     {"type": "hello", "sessions": [<state>, ...]}    first, on every connect: each session the host holds
//     {"type": "session", ...<state>}                  one changed; "open": false once its process ended
//
// A <state> is {id, open, working, asks, prompted, replied, ended}, its times in ms, null while the host has seen none. The
// socket closing says the host is gone, and every process it held with it. A desk that restarts, as on every Try,
// misses nothing: the host connects again within a second and says everything anew.
//
// A host of older code says nothing. While one runs, as for the hours after this landed until it gave way to one of
// this code (hosted.ts swaps it once its sessions are quiet), desk reads as it did before, from the transcripts
// (sessions.ts) and the host's list, and looks again every few seconds, since nothing tells it (lookWhileOlder); so
// does the moment after desk starts, before the host's hello. On 19 Oct 8790's host had run since the night before,
// its sessions never all quiet.
import { statSync } from "node:fs";
import type { WebSocket } from "ws";
import * as chats from "./chats.ts";
import * as db from "./db.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import * as sessions from "./sessions.ts";
import * as transcript from "./transcript.ts";

interface Row {
  id: string;
  open: boolean;
  working: boolean;
  asks: number;
  prompted: number | null; // in seconds, as pages.ts counts
  replied: number | null;
  ended: number | null;
  updated: number;
}

interface State {
  id: string;
  open: boolean;
  working: boolean;
  asks: number;
  prompted: number | null; // in ms, as the host sends it
  replied: number | null;
  ended: number | null;
}

// The table, as desk last wrote it: desk is its one writer, so the copy here is what the table holds.
const rows = new Map<string, Row>();
// A host of this code tells desk: the table is current. False while an older host runs, until a host says hello.
let reporting = false;
let host: WebSocket | null = null; // the host's socket now
let stopping = false;
const listeners = new Set<Listener>();
const waiters = new Set<() => void>(); // settled's, each looking again at every change

const COLUMNS = `id, open, working, asks, extract(epoch from prompted)::float8 as prompted, extract(epoch from replied)::float8 as replied,
  extract(epoch from ended)::float8 as ended, extract(epoch from updated)::float8 as updated`;

// The sessions that changed, or null when every one may have, as when the host first says hello; and those of them
// whose turn ended, so that what they wrote beside their issue is read again.
type Listener = (sessions: string[] | null, ended: string[]) => void;

// Each change, as the host says it: sync.ts sends the frame and the open chats again, and the line looks (land.ts).
export const onChange = (fn: Listener) => { listeners.add(fn); };

function changed(sessions: string[] | null, ended: string[] = []) {
  for (const fn of listeners) fn(sessions, ended);
  for (const look of waiters) look();
}

// --- reading -----------------------------------------------------------------------------------------------------------

export const reports = () => reporting;

// Whether a turn of the session runs now.
export function working(session: string): boolean {
  if (!reporting) return sessions.working(session);
  const r = rows.get(session);
  return Boolean(r?.open && r.working);
}

// When the user last wrote to the session, and when its last reply ended, in seconds.
export const prompted = (session: string): number | null => (reporting ? rows.get(session)?.prompted ?? null : sessions.prompted(session));
export const replied = (session: string): number | null => (reporting ? rows.get(session)?.replied ?? null : sessions.replied(session));

// When the session's last turn ended, however it ended. A transcript tells only the user's prompts and the replies,
// whose latest stands in for it.
export function ended(session: string): number | null {
  if (reporting) return rows.get(session)?.ended ?? null;
  const asked = sessions.prompted(session);
  return asked === null ? null : Math.max(asked, sessions.replied(session) ?? 0);
}

// The sessions waiting on the user now: a tool to allow, or AskUserQuestion's questions.
export async function asking(): Promise<Set<string>> {
  if (!reporting) return new Set((await hosted.sessions()).filter((h) => h.asks).map((h) => h.id));
  return new Set([...rows.values()].filter((r) => r.open && r.asks).map((r) => r.id));
}

// Whether the host holds the session's process now.
export const hosting = async (session: string): Promise<boolean> => (reporting ? Boolean(rows.get(session)?.open) : Boolean(await hosted.holds(session)));

// Once no turn of the session runs and nothing of it waits on the user: true, or false when that took longer than
// seconds. Looked at again on each word from the host, not asked over and over.
export function settled(session: string, seconds: number): Promise<boolean> {
  const now = () => !working(session) && !(reporting && rows.get(session)?.asks);
  if (now()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (yes: boolean) => {
      waiters.delete(look);
      clearTimeout(late);
      resolve(yes);
    };
    const look = () => { if (now()) done(true); };
    const late = setTimeout(() => done(false), seconds * 1000);
    waiters.add(look);
  });
}

// --- writing -----------------------------------------------------------------------------------------------------------

const seconds = (ms: number | null) => (ms === null ? null : ms / 1000);

// The host's word for a session. Its times only move on: a host that has not yet seen the session's prompt or reply,
// as one that just resumed it, leaves the table's.
async function upsert(tx: db.Db, s: State): Promise<Row> {
  return (await tx.query<Row>(`insert into sessions (id, open, working, asks, prompted, replied, ended)
    values ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), to_timestamp($7))
    on conflict (id) do update set open = excluded.open, working = excluded.working, asks = excluded.asks,
      prompted = greatest(sessions.prompted, excluded.prompted), replied = greatest(sessions.replied, excluded.replied),
      ended = greatest(sessions.ended, excluded.ended), updated = now()
    returning ${COLUMNS}`, [s.id, s.open, s.open && s.working, s.open ? s.asks : 0, seconds(s.prompted), seconds(s.replied), seconds(s.ended)])).rows[0];
}

async function upsertAll(tx: db.Db, states: State[]): Promise<Row[]> {
  const written: Row[] = [];
  for (const s of states) written.push(await upsert(tx, s));
  return written;
}

// Those whose process is gone: a turn that ran ended with it.
const closeAll = (tx: db.Db, except: string[] = []) =>
  tx.query<Row>(`update sessions set open = false, working = false, asks = 0, ended = case when working then now() else ended end, updated = now()
    where open and not (id = any($1)) returning ${COLUMNS}`, [except]);

// Keep what a write returned; a chat whose turn started or ended moved now (chats.ts), and the listeners are told.
function kept(written: Row[]) {
  const ended: string[] = [];
  for (const r of written) {
    const was = rows.get(r.id)?.working ?? false;
    if (was !== r.working) chats.moved(r.id);
    if (was && !r.working) ended.push(r.id);
    rows.set(r.id, r);
  }
  if (written.length) changed(written.map((r) => r.id), ended);
}

// The sessions desk keeps, issues' and chats', that ran where no host of this code told desk, such as an older host
// before it gave way, or a terminal: their prompts and replies are read in from their transcripts, which changed since
// the table last heard of them. On a fresh table, that is every one, once.
async function catchUp() {
  const ids = new Set([...(await store.loadAll()).values()].map((i) => i.session).filter((s): s is string => Boolean(s)));
  for (const chat of chats.agentChats()) if (chat.session) ids.add(chat.session);
  const behind: State[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (r?.open) continue; // the host says it
    const path = transcript.pathOf(id);
    if (!path) continue;
    let moved: number;
    try {
      moved = statSync(path).mtimeMs / 1000;
    } catch {
      continue;
    }
    if (r && moved <= r.updated) continue;
    const ms = (t: number | null) => (t === null ? null : t * 1000);
    const asked = sessions.prompted(id), said = sessions.replied(id);
    behind.push({ id, open: false, working: false, asks: 0, prompted: ms(asked), replied: ms(said), ended: ms(asked === null ? null : Math.max(asked, said ?? 0)) });
  }
  if (behind.length) kept(await db.write((tx) => upsertAll(tx, behind)));
}

// While a host of older code runs, which tells desk nothing, desk looks again at every session every few seconds, as
// it did before the host told it: the listeners read the transcripts then (sessions.ts). The host's hello ends it.
const OLDER_LOOK = 5000; // ms
let older: NodeJS.Timeout | null = null;
const lookWhileOlder = () => { older ??= setInterval(() => changed(null), OLDER_LOOK); };

async function hello(ws: WebSocket, states: State[]) {
  host = ws;
  // Those the host no longer holds ended while desk was away.
  kept(await db.write(async (tx) => [...(await closeAll(tx, states.map((s) => s.id))).rows, ...(await upsertAll(tx, states))]));
  if (!reporting) {
    await catchUp();
    reporting = true;
    if (older) clearInterval(older);
    older = null;
    changed(null);
  }
}

// The host's socket: what it says, in order.
export function connect(ws: WebSocket) {
  let heard = Promise.resolve();
  ws.on("message", (data) => {
    let e: { type?: string; sessions?: State[] } & Partial<State>;
    try {
      e = JSON.parse(data.toString());
    } catch {
      return;
    }
    heard = heard.then(async () => {
      if (e.type === "hello") await hello(ws, e.sessions ?? []);
      else if (e.type === "session" && e.id) kept([await db.write((tx) => upsert(tx, e as State))]);
    }).catch((error) => console.error("desk: the host's word", error));
  });
  // The host is gone, and every process it held, unless desk is the one stopping.
  ws.on("close", () => {
    heard = heard.then(async () => {
      if (host !== ws || stopping) return;
      host = null;
      kept((await db.write((tx) => closeAll(tx))).rows);
    }).catch((error) => console.error("desk: the host left", error));
  });
}

// At start: the table as it was, and whether a host runs. With none, no process runs, and the table says so at once;
// one of this code says hello in a moment; an older one says nothing until it gives way.
export async function load() {
  for (const r of (await db.sql().query<Row>(`select ${COLUMNS} from sessions`)).rows) rows.set(r.id, r);
  if ((await hosted.standing()) !== "none") return lookWhileOlder();
  kept((await db.write((tx) => closeAll(tx))).rows);
  await catchUp();
  reporting = true;
}

// desk is stopping: its socket to the host closes, but the host and its sessions go on.
export const stop = () => { stopping = true; };
