// Sync for the app (ported from desk/sync.py): a WebSocket that sends every issue when the app connects, then each change the moment
// an issue changes, whoever made it: a page, an agent's curl, desk itself, or the user's editor. The app's own changes go
// through the JSON API and come back this way, like everyone else's.
//
//     {"type": "snapshot", "seq": 7, "issues": [<issue>, ...], "projects": [<project>, ...]}   first, on every connect
//     {"type": "changes",  "seq": 8, "upsert": [<issue>, ...], "delete": [<slug>, ...], "projects": [...]}
//     {"type": "frame", "frame": <frame>}                                                       on connect, then when it changed
//     {"type": "files", "slugs": [<slug>, ...]}                                                 its description or files changed
//
// An <issue> is what GET /api/issues lists (api.ts, asJson); a <project> is {slug, title, state}. "projects" comes in a
// change only when a project changed, as the whole list. A <frame> is the sidebar and the Inbox's rows, with each open
// issue's session state (pages.ts, framePage). "files" names the issues whose description or other files changed (a
// session's plan.md, questions.md, result.md, a screenshot), which no field the apps hold says: a page showing one of
// them asks again.
//
// desk's own saves tell this module at once (issues.onChange). An editor's change to an issue.md or project.md is seen
// on the folders, read into the database (reconcile), and sent the same way.
import { mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { WebSocket } from "ws";
import * as agents from "./agents.ts";
import { asJson } from "./api.ts";
import * as chats from "./chats.ts";
import { HOME, ISSUES_DIR, PROJECTS_DIR } from "./config.ts";
import * as store from "./issues.ts";
import * as pages from "./pages.ts";
import * as projects from "./projects.ts";

let issues = new Map<string, string>(); // slug: the issue as the apps were last told, as JSON
let bodies = new Map<string, string>(); // slug: its description, which the apps do not hold, as last read
let projectList = "[]";
let seq = 0;
const listeners = new Set<WebSocket>();

async function snapshot(): Promise<[Map<string, string>, Map<string, string>]> {
  const all = [...(await store.loadAll())];
  return [new Map(all.map(([slug, i]) => [slug, JSON.stringify(asJson(i))])), new Map(all.map(([slug, i]) => [slug, i.body]))];
}

async function listProjects(): Promise<string> {
  const all = [...(await projects.loadAll()).values()].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return JSON.stringify(all.map((p) => ({ slug: p.slug, title: p.title, state: p.state })));
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

// Read every issue again and tell the apps what differs from what they were told.
// A description is no field the apps hold, so one rewritten, as by an agent's PATCH, goes as "files": the page showing
// that issue asks for it again.
async function checkNow() {
  const [next, nextBodies] = await snapshot(), listed = await listProjects();
  const upsert = [...next].filter(([slug, i]) => issues.get(slug) !== i).map(([, i]) => i);
  const gone = [...issues.keys()].filter((slug) => !next.has(slug));
  const moved = listed !== projectList;
  const rewritten = [...nextBodies].filter(([slug, body]) => bodies.has(slug) && bodies.get(slug) !== body).map(([slug]) => slug);
  issues = next;
  bodies = nextBodies;
  projectList = listed;
  if (rewritten.length) {
    const message = JSON.stringify({ type: "files", slugs: rewritten });
    for (const ws of listeners) ws.send(message);
  }
  if (!upsert.length && !gone.length && !moved) return;
  seq++;
  const message = `{"type":"changes","seq":${seq},"upsert":[${upsert.join(",")}],"delete":${JSON.stringify(gone)}${moved ? `,"projects":${listed}` : ""}}`;
  for (const ws of listeners) ws.send(message);
}

export const check = serial("sync", checkNow);

// --- the frame ---------------------------------------------------------------------------------------------------------
// A session that starts or stops working, or writes its plan, questions or result, changes no issue, yet the Inbox and
// the strips say it. Claude Code rewrites ~/.claude/sessions/<pid>.json the moment a session's turn starts or ends
// ("status": busy or idle; `claude agents` reads it there) and removes it when the process ends, so desk watches those
// and the files a session writes beside issue.md, and sends the frame again when it changed. A tick catches what no
// file shows: time (a landing stuck for a minute) and the window in front (a chat's reply read as it came).

const SESSIONS = join(HOME, ".claude", "sessions");
const AGENT_FILES = ["plan.md", "questions.md", "result.md"];
const TICK = 5000; // ms

let frameText = ""; // the frame as the apps were last told

async function frameNow() {
  if (!listeners.size) {
    frameText = ""; // an app that connects next is told afresh
    return;
  }
  await agents.live(true); // the frame's own asks reuse this answer
  const text = JSON.stringify(await pages.framePage());
  if (text === frameText) return;
  frameText = text;
  const message = `{"type":"frame","frame":${text}}`;
  for (const ws of listeners) ws.send(message);
}

const frame = serial("sync frame", frameNow);

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

// An issue's or a project's own file, or its folder coming or going (a new issue, a delete into the trash). Files a
// session writes beside issue.md (result.md, screenshots) change no field the apps hold.
const interesting = (path: string) =>
  [store.MAIN, projects.MAIN].includes(basename(path)) || [ISSUES_DIR, PROJECTS_DIR].includes(dirname(path));

// Watch the folders for changes desk did not make, read them in, and tell the apps; watch the sessions, and tell the
// apps the frame.
export async function start() {
  [issues, bodies] = await snapshot();
  projectList = await listProjects();
  const changed = () => {
    void check();
    void frame();
  };
  store.onChange(changed);
  projects.onChange(changed);
  const readIn = soon(async () => {
    try {
      const a = await store.reconcile(), b = await projects.reconcile();
      if (a || b) changed();
    } catch (error) {
      console.error("sync watcher", error);
    }
  });
  const agentWrote = soon(() => void frame());
  const touched = new Set<string>();
  const tellFiles = soon(() => {
    const message = JSON.stringify({ type: "files", slugs: [...touched] });
    touched.clear();
    for (const ws of listeners) ws.send(message);
  });
  for (const root of [ISSUES_DIR, PROJECTS_DIR]) {
    mkdirSync(root, { recursive: true });
    watch(root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = join(root, name.toString());
      if (interesting(path)) return readIn();
      if (root !== ISSUES_DIR) return;
      const slug = name.toString().split(sep)[0];
      if (slug.startsWith(".")) return; // a hidden folder, not an issue
      touched.add(slug);
      tellFiles();
      if (AGENT_FILES.includes(basename(path))) agentWrote();
    });
  }
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
    if (listeners.size) void frame();
  }, TICK);
}

// A connected app: the snapshot and the frame first, then each change until it leaves.
export function connect(ws: WebSocket) {
  listeners.add(ws);
  ws.send(`{"type":"snapshot","seq":${seq},"issues":[${[...issues.values()].join(",")}],"projects":${projectList}}`);
  if (frameText) ws.send(`{"type":"frame","frame":${frameText}}`);
  void frame(); // what it was told may be from before the last app left
  ws.on("close", () => listeners.delete(ws));
  ws.on("error", () => listeners.delete(ws));
}

// The process is stopping: close every socket, so the apps reconnect to the desk that comes next (code 1012, restart).
export function closeAll() {
  for (const ws of listeners) ws.close(1012);
  listeners.clear();
}
