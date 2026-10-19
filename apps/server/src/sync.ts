// Sync for the app (ported from desk/sync.py): a WebSocket that gives the app every row it holds, issues, projects,
// chats and the Inbox's, then each change the moment it is written, numbered as the log numbers it (db.ts), whoever made it: a page, an
// agent's curl, or desk itself. The app's own changes go through the JSON API and come back this way, like everyone
// else's. An app that lost desk, as when desk restarts, connects again with the last change it
// applied, and gets only what it missed.
//
//     /api/sync?log=<log>&since=<seq>     the log and the last change the app applied; a new tab sends both empty
//
//     {"type": "snapshot", "log": "<log>", "seq": 812, "rows": {"issues": [<issue>, ...], "projects": [<project>, ...], "chats": [<chat>, ...], "inbox": [<row>, ...]}}
//     {"type": "changes", "after": 811, "changes": [{"seq": 812, "kind": "issues", "key": "<slug>", "row": <issue>}, ...]}
//     {"type": "frame", "frame": <frame>}                         on connect, then when it changed
//     {"type": "files", "slugs": [<slug>, ...]}                   its other files changed
//
// The first answer is the snapshot, or the changes the app missed, maybe none. Each "changes" goes on from the one
// before it, whose last change is its "after": an app that holds another seq missed some, and connects again to get
// them. A row is the table's, less what the app is not sent (db.ts, HELD): an <issue> is every field of issue.md but
// its description, a <project> its slug, title, state and created, a <chat> its id, session, issue, title and who it is
// with, an Inbox <row> every column (inbox.ts); a deleted row comes as null. A description is part of its issue's row, so a new one comes as a change: the page
// showing it asks again. A <frame> is the sidebar's sessions and desk's checkout, with each open issue's session state
// (pages.ts, framePage), which no table holds yet. "files" names the issues whose files beside issue.md may have changed
// (a screenshot, or an older issue's plan.md and result.md), which no row holds either: a page showing one of them asks
// again.
//
// desk watches no file and asks nothing again on a timer: "when agent changes sth, it calls api, not edit file and desk
// fetches from file later" (the user, 19 Oct). Each change comes from a write, through the one write path, or from the
// session host's word (turns.ts). issue.md and project.md are only written out: one changed by hand is not read, and
// tells the apps nothing (db.ts).
import type { WebSocket } from "ws";
import * as agents from "./agents.ts";
import { asJson } from "./api.ts";
import * as automations from "./automations.ts";
import * as chats from "./chats.ts";
import * as db from "./db.ts";
import type { Change } from "./db.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as live from "./live.ts";
import * as pages from "./pages.ts";
import * as turns from "./turns.ts";

const listeners = new Set<WebSocket>();

// Each write's changes, as it commits, to every app: still under db.locked, so an app joining sees them in order.
function told(changes: db.Change[], after: number) {
  const message = JSON.stringify({ type: "changes", after, changes });
  for (const ws of listeners) ws.send(message);
  if (legacy.size) {
    const old = oldChanges(changes);
    for (const ws of legacy) ws.send(old);
  }
}

// --- a tab still on the app from before the log (19 Oct), which reads issues as GET /api/issues lists them, and the
// Inbox's count, Triage and the projects from the frame (pages.ts, framePage): until it reloads.

const legacy = new Set<WebSocket>();

// Whether such a tab is open, whose frame, fetched too after an action, then carries what it reads there.
export const oldTabs = () => legacy.size > 0;

async function oldSnapshot(): Promise<string> {
  const { seq, rows } = await db.snapshot();
  const listed = rows.projects.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  return JSON.stringify({ type: "snapshot", seq, issues: rows.issues.map((i) => asJson(i as unknown as Issue)),
    projects: listed.map((p) => ({ slug: p.slug, title: p.title, state: p.state })) });
}

function oldChanges(changes: Change[]): string {
  const issues = changes.filter((c) => c.kind === "issues");
  return JSON.stringify({ type: "changes", seq: changes.at(-1)!.seq, upsert: issues.filter((c) => c.row).map((c) => asJson(c.row as unknown as Issue)),
    delete: issues.filter((c) => !c.row).map((c) => c.key) });
}

// One run at a time, and one more after it when asked meanwhile.
function serial(name: string, work: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null, again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await work();
        } while (again);
      } catch (error) {
        console.error(name, error);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

// --- the frame ---------------------------------------------------------------------------------------------------------
// A session that starts or stops working, or asks you something, changes no row the app holds, yet the Inbox and the
// strips say it. So the frame goes again after every write that changed a row of any table (db.onCommit), such as the
// line's, and on each word from the session host: a turn started or ended, a question waits, a process ended (turns.ts).
// What a session wrote beside its issue, such as a screenshot, is read again once its turn ends. Only time moves the
// frame on its own, when a landing has been stuck for a minute: one timer, set for that moment. (While a host of older
// code runs, which says nothing, turns.ts looks again every few seconds instead, until it gives way.)

let frameText = ""; // the frame as the apps were last told

async function frameNow() {
  if (!listeners.size && !legacy.size) {
    frameText = ""; // an app that connects next is told afresh
    return;
  }
  if (!turns.reports()) await agents.live(true); // the frame's own asks of the host reuse this answer
  const all = await store.loadAll();
  const text = JSON.stringify(await pages.framePage(legacy.size > 0, all));
  wakeAt(pages.nextMove(all));
  if (text === frameText) return;
  frameText = text;
  const message = `{"type":"frame","frame":${text}}`;
  for (const ws of [...listeners, ...legacy]) ws.send(message);
}

const frame = serial("sync frame", frameNow);

// Something the frame shows changed that no write says: tell the apps now.
export const frameChanged = () => void frame();

let wake: NodeJS.Timeout | null = null;

// The frame goes again at the moment time alone will move it, if any (ms).
function wakeAt(at: number | null) {
  if (wake) clearTimeout(wake);
  wake = at === null ? null : setTimeout(() => { wake = null; void frame(); }, Math.max(0, at - Date.now()));
}

// The issues whose files a session may have written, now that its turn ended: its own, and a chat's.
async function wroteIn(sessions: string[]): Promise<string[]> {
  const ended = new Set(sessions), slugs = new Set<string>();
  for (const i of (await store.loadAll()).values()) if (i.session && ended.has(i.session)) slugs.add(i.slug);
  for (const chat of chats.agentChats()) if (chat.issue && ended.has(chat.session)) slugs.add(chat.issue);
  return [...slugs];
}

function tellFiles(slugs: string[]) {
  if (!slugs.length) return;
  const message = JSON.stringify({ type: "files", slugs });
  for (const ws of [...listeners, ...legacy]) ws.send(message);
}

// Tell the apps each write, and the frame after it and after each word from the host; and the open chats.
export async function start() {
  db.onWrite(told);
  db.onCommit(() => {
    void frame();
    live.moved(null);
  });
  turns.onChange((sessions, ended) => {
    void frame();
    live.moved(sessions);
    if (ended.length) void wroteIn(ended).then(tellFiles).catch((error) => console.error("sync files", error));
  });
  automations.onChange(() => void frame());
}

// A connected app: every row, or what it missed since the change it names, and the frame; then each change until it
// leaves. An app that names no change at all is one from before the log.
export async function connect(ws: WebSocket, query: Record<string, string | undefined>) {
  const leave = () => {
    listeners.delete(ws);
    legacy.delete(ws);
  };
  ws.on("close", leave);
  ws.on("error", leave);
  try {
    await db.locked(async () => {
      if (ws.readyState !== ws.OPEN) return;
      if (query.since === undefined) {
        ws.send(await oldSnapshot());
        legacy.add(ws);
        return;
      }
      const missed = query.since ? await db.since(query.log ?? "", Number(query.since)) : null;
      ws.send(JSON.stringify(missed ? { type: "changes", after: Number(query.since), changes: missed } : { type: "snapshot", ...(await db.snapshot()) }));
      listeners.add(ws);
    });
  } catch (error) {
    console.error("sync connect", error);
    ws.close(1011);
    return;
  }
  if (frameText && ws.readyState === ws.OPEN) ws.send(`{"type":"frame","frame":${frameText}}`);
  void frame(); // what it was told may be from before the last app left
}

// The process is stopping: close every socket, so the apps reconnect to the desk that comes next (code 1012, restart).
export function closeAll() {
  for (const ws of [...listeners, ...legacy]) ws.close(1012);
  listeners.clear();
  legacy.clear();
}
