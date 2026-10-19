// Sync for the app (ported from desk/sync.py): a WebSocket that gives the app every row it holds, issues, projects and
// chats, then each change the moment it is written, numbered as the log numbers it (db.ts), whoever made it: a page, an
// agent's curl, desk itself, or the user's editor. The app's own changes go through the JSON API and come back this
// way, like everyone else's. An app that lost desk, as when desk restarts, connects again with the last change it
// applied, and gets only what it missed.
//
//     /api/sync?log=<log>&since=<seq>     the log and the last change the app applied; a new tab sends both empty
//
//     {"type": "snapshot", "log": "<log>", "seq": 812, "rows": {"issues": [<issue>, ...], "projects": [<project>, ...], "chats": [<chat>, ...]}}
//     {"type": "changes", "after": 811, "changes": [{"seq": 812, "kind": "issues", "key": "<slug>", "row": <issue>}, ...]}
//     {"type": "frame", "frame": <frame>}                         on connect, then when it changed
//     {"type": "files", "slugs": [<slug>, ...]}                   its other files changed
//
// The first answer is the snapshot, or the changes the app missed, maybe none. Each "changes" goes on from the one
// before it, whose last change is its "after": an app that holds another seq missed some, and connects again to get
// them. A row is the table's, less what the app is not sent (db.ts, HELD): an <issue> is every field of issue.md but
// its description, a <project> its slug, title, state and created, a <chat> its id, session, issue, title and who it is
// with; a deleted row comes as null. A description is part of its issue's row, so a new one comes as a change: the page
// showing it asks again. A <frame> is the sidebar and the Inbox's rows, with each open issue's session state (pages.ts,
// framePage), which no table holds yet. "files" names the issues whose files beside issue.md changed (a session's
// plan.md, result.md, a screenshot), which no row holds either: a page showing one of them asks again.
//
// issue.md and project.md are only written out: one changed by hand is not read, and tells the apps nothing (db.ts).
import { mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { WebSocket } from "ws";
import * as agents from "./agents.ts";
import { asJson } from "./api.ts";
import * as chats from "./chats.ts";
import { HOME, ISSUES_DIR } from "./config.ts";
import * as db from "./db.ts";
import type { Change } from "./db.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
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
  void frame(); // the sidebar and the Inbox read the issues too
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
// A session that starts or stops working, asks you something, or writes its plan or result, changes no issue, yet the
// Inbox and the strips say it. The session host tells desk the moment a turn starts or ends, a question waits, or a
// process ends (turns.ts), so the frame goes again then, and when a session writes a file beside issue.md. Until a host
// of this code tells desk, Claude Code's own ~/.claude/sessions/<pid>.json says when a turn starts or ends ("status":
// busy or idle; `claude agents` reads it there), so desk watches those too. A tick catches what neither shows: time (a
// landing stuck for a minute) and the window in front (a chat's reply read as it came).

const SESSIONS = join(HOME, ".claude", "sessions");
const AGENT_FILES = ["plan.md", "result.md"];
const TICK = 5000; // ms

let frameText = ""; // the frame as the apps were last told

async function frameNow() {
  if (!listeners.size && !legacy.size) {
    frameText = ""; // an app that connects next is told afresh
    return;
  }
  if (!turns.reports()) await agents.live(true); // the frame's own asks of the host reuse this answer
  const text = JSON.stringify(await pages.framePage(legacy.size > 0));
  if (text === frameText) return;
  frameText = text;
  const message = `{"type":"frame","frame":${text}}`;
  for (const ws of [...listeners, ...legacy]) ws.send(message);
}

const frame = serial("sync frame", frameNow);

// Something the frame shows changed that no write or watcher sees, such as a pin: tell the apps now.
export const frameChanged = () => void frame();

// What each running session is doing, as its state file says: busy or idle, by session id.
function sessionStates(): Map<string, string> {
  const states = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(SESSIONS).filter((n) => n.endsWith(".json"));
  } catch {
    return states;
  }
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS, n), "utf8"));
      states.set(s.sessionId, s.status);
    } catch {
      states.set(n, ""); // written as we read: its next write tells again
    }
  }
  return states;
}

// Gathers a burst of writes into one call of fn.
function soon(fn: () => void, ms = 50): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (!timer) timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

// Desk's own writes in the issues' folders, told as writes already: an issue.md, or a folder coming or going (a new
// issue, a delete into the trash).
const desks = (path: string) => basename(path) === store.MAIN || dirname(path) === ISSUES_DIR;

// Tell the apps each write; watch the issues' folders for the files a session writes beside issue.md (result.md,
// screenshots), which no row holds, and the sessions, and tell the apps the frame.
export async function start() {
  db.onWrite(told);
  turns.onChange(() => void frame());
  const agentWrote = soon(() => void frame());
  const touched = new Set<string>();
  const tellFiles = soon(() => {
    const message = JSON.stringify({ type: "files", slugs: [...touched] });
    touched.clear();
    for (const ws of [...listeners, ...legacy]) ws.send(message);
  });
  mkdirSync(ISSUES_DIR, { recursive: true });
  watch(ISSUES_DIR, { recursive: true }, (_event, name) => {
    if (!name) return;
    const path = join(ISSUES_DIR, name.toString());
    const slug = name.toString().split(sep)[0];
    if (slug.startsWith(".") || desks(path)) return; // a hidden folder is not an issue
    touched.add(slug);
    tellFiles();
    if (AGENT_FILES.includes(basename(path))) agentWrote();
  });
  mkdirSync(SESSIONS, { recursive: true });
  let states = sessionStates();
  const moved = soon(() => {
    const now = sessionStates();
    const turned = [...now.keys()].filter((sid) => states.get(sid) !== now.get(sid));
    const ended = [...states.keys()].some((sid) => !now.has(sid));
    states = now;
    if (!turned.length && !ended) return; // a write that changed no session's state, such as its name
    for (const sid of turned) chats.moved(sid); // a turn started or ended: the chat moved now
    void frame();
  });
  watch(SESSIONS, (_event, name) => {
    if (name?.toString().endsWith(".json")) moved();
  });
  setInterval(() => {
    if (listeners.size || legacy.size) void frame();
  }, TICK);
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
