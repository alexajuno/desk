// Sync for the app (ported from desk/sync.py): a WebSocket that sends every issue when the app connects, then each change the moment
// an issue changes, whoever made it: a page, an agent's curl, desk itself, or the user's editor. The app's own changes go
// through the JSON API and come back this way, like everyone else's.
//
//     {"type": "snapshot", "seq": 7, "issues": [<issue>, ...], "projects": [<project>, ...]}   first, on every connect
//     {"type": "changes",  "seq": 8, "upsert": [<issue>, ...], "delete": [<slug>, ...], "projects": [...]}
//
// An <issue> is what GET /api/issues lists (api.ts, asJson); a <project> is {slug, title, state}. "projects" comes in a
// change only when a project changed, as the whole list.
//
// desk's own saves tell this module at once (issues.onChange). An editor's change to an issue.md or project.md is seen
// on the folders, read into the database (reconcile), and sent the same way.
import { mkdirSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WebSocket } from "ws";
import { asJson } from "./api.ts";
import { ISSUES_DIR, PROJECTS_DIR } from "./config.ts";
import * as store from "./issues.ts";
import * as projects from "./projects.ts";

let issues = new Map<string, string>(); // slug: the issue as the apps were last told, as JSON
let projectList = "[]";
let seq = 0;
const listeners = new Set<WebSocket>();

async function snapshot(): Promise<Map<string, string>> {
  return new Map([...(await store.loadAll())].map(([slug, i]) => [slug, JSON.stringify(asJson(i))]));
}

async function listProjects(): Promise<string> {
  const all = [...(await projects.loadAll()).values()].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return JSON.stringify(all.map((p) => ({ slug: p.slug, title: p.title, state: p.state })));
}

// One check at a time, and one more after it when something changed meanwhile.
let checking: Promise<void> | null = null, again = false;

// Read every issue again and tell the apps what differs from what they were told.
async function checkNow() {
  const next = await snapshot(), listed = await listProjects();
  const upsert = [...next].filter(([slug, i]) => issues.get(slug) !== i).map(([, i]) => i);
  const gone = [...issues.keys()].filter((slug) => !next.has(slug));
  const moved = listed !== projectList;
  issues = next;
  projectList = listed;
  if (!upsert.length && !gone.length && !moved) return;
  seq++;
  const message = `{"type":"changes","seq":${seq},"upsert":[${upsert.join(",")}],"delete":${JSON.stringify(gone)}${moved ? `,"projects":${listed}` : ""}}`;
  for (const ws of listeners) ws.send(message);
}

export function check(): Promise<void> {
  if (checking) {
    again = true;
    return checking;
  }
  checking = (async () => {
    try {
      do {
        again = false;
        await checkNow();
      } while (again);
    } catch (error) {
      console.error("sync", error);
    } finally {
      checking = null;
    }
  })();
  return checking;
}

// An issue's or a project's own file, or its folder coming or going (a new issue, a delete into the trash). Files a
// session writes beside issue.md (result.md, screenshots) change no field the apps hold.
const interesting = (path: string) =>
  [store.MAIN, projects.MAIN].includes(basename(path)) || [ISSUES_DIR, PROJECTS_DIR].includes(dirname(path));

// Watch the folders for changes desk did not make, read them in, and tell the apps.
export async function start() {
  issues = await snapshot();
  projectList = await listProjects();
  store.onChange(() => void check());
  projects.onChange(() => void check());
  let timer: NodeJS.Timeout | null = null;
  const fire = async () => {
    timer = null;
    try {
      const a = await store.reconcile(), b = await projects.reconcile();
      if (a || b) await check();
    } catch (error) {
      console.error("sync watcher", error);
    }
  };
  for (const root of [ISSUES_DIR, PROJECTS_DIR]) {
    mkdirSync(root, { recursive: true });
    watch(root, { recursive: true }, (_event, name) => {
      if (!name || !interesting(join(root, name.toString()))) return;
      if (!timer) timer = setTimeout(fire, 50);
    });
  }
}

// A connected app: the snapshot first, then each change until it leaves.
export function connect(ws: WebSocket) {
  listeners.add(ws);
  ws.send(`{"type":"snapshot","seq":${seq},"issues":[${[...issues.values()].join(",")}],"projects":${projectList}}`);
  ws.on("close", () => listeners.delete(ws));
  ws.on("error", () => listeners.delete(ws));
}

// The process is stopping: close every socket, so the apps reconnect to the desk that comes next (code 1012, restart).
export function closeAll() {
  for (const ws of listeners) ws.close(1012);
  listeners.clear();
}
