// The session panel's side on the server: one WebSocket per open panel, which tells the app the session's
// conversation and keeps it current, and what the panel sends back (a message, Stop, an answer).
//
//     {"type": "hello", "meta": <meta>, "items": [<item>, ...], "working": false, "asks": [...], "partial": [...]}
//     {"type": "items", "items": [<item>, ...]}                  new items, from the transcript or the host, each once
//     {"type": "stream", "msg": …, "index": 0, "kind": "text", "text": "…"}   a piece of a reply (host.ts)
//     {"type": "working", "working": true}
//     {"type": "asks", "asks": [...]}
//     {"type": "tasks", "tasks": [...]}                          what runs beside the conversation now (host.ts)
//     {"type": "status", "status": {...} | null}                 a retry, a compaction or a usage limit holds the turn up
//     {"type": "meta", "meta": <meta>}                           its title, folder, issue, model or effort changed
//
// An <item> is transcript.ts's. The app sends {"type": "visible", "visible": true} as its tab shows or hides, so desk
// knows whether the user reads a chat's reply as it comes (the Inbox then leaves it out).
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as hosted from "./hosted.ts";
import * as inbox from "./inbox.ts";
import * as store from "./issues.ts";
import * as models from "./models.ts";
import * as roster from "./roster.ts";
import * as transcript from "./transcript.ts";
import type { Item } from "./transcript.ts";

export const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const visible = new Map<WebSocket, string>(); // the panels showing now, and their sessions

// Whether a panel the user looks at shows the session now.
export function watching(session: string | null | undefined): boolean {
  return Boolean(session) && [...visible.values()].includes(session!);
}

interface Meta {
  id: string;
  title: string;
  cwd: string;
  folder: string;
  issue: { slug: string; title: string; state: string } | null;
  chat: boolean;
  agent: string | null; // the agent a chat is with
  bare: boolean; // a chat with no agent and no desk prompt (chats.ts)
  picked: boolean; // a new chat's folder, picked in its composer (chats.ts, startIn)
  runs: models.Shown; // the model and effort, for the composer's chip
}

const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

export async function meta(id: string): Promise<Meta> {
  const chat = chats.agentChatOf(id);
  const all = await store.loadAll();
  const issue = [...all.values()].find((i) => i.session === id) ?? (chat?.issue ? all.get(chat.issue) : undefined) ?? null;
  const row = await agents.liveRow(id);
  const cwd = row.cwd ?? (chat ? chats.runsIn(chat) : transcript.cwdOf(id)) ?? "";
  const { chatTitleOf, titleOf } = await import("./sessions.ts");
  return {
    id, cwd, folder: tilde(cwd), chat: Boolean(chat), agent: chat?.agent ?? null, bare: Boolean(chat?.bare),
    picked: Boolean(chat?.cwd && !chat.issue && !chat.agent && !chat.bare), // a bound chat's cwd is its issue's folder
    // A bare chat by the title the sidebar's Chats give it, not by the name desk started its session with; any chat by
    // the user's own title.
    title: issue?.title || chat?.named || (chat?.bare ? chatTitleOf(id) : "") || (chat && chat.title !== "New chat" ? chat.title : "") || titleOf(id) || "New session",
    issue: issue ? { slug: issue.slug, title: issue.title, state: issue.state } : null,
    runs: models.shown(id, Boolean(chat)),
  };
}

// --- the socket ------------------------------------------------------------------------------------------------------

export async function connect(ws: WebSocket, id: string) {
  // Heard before anything is awaited: the app says whether it shows the session as soon as the socket opens, and a
  // message with no listener yet is lost.
  ws.on("message", (data) => {
    try {
      const e = JSON.parse(data.toString());
      if (e.type === "visible") {
        // A session on screen is read, up to the moment it leaves the screen: its Inbox row, in every tab.
        if (e.visible) visible.set(ws, id);
        if (e.visible || visible.delete(ws)) void inbox.read({ session: id });
      }
    } catch {
      // not ours
    }
  });
  ws.on("close", () => { if (visible.delete(ws)) void inbox.read({ session: id }); });
  const sent = new Set<string>(); // the items' keys the panel has, so each comes once from whichever source is first
  let path: string | null = null, readTo = 0, file: FSWatcher | null = null, host: WebSocket | null = null, closed = false;
  let lastMeta = "";
  const say = (event: Record<string, unknown>) => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const fresh = (items: Item[]) => items.filter((i) => !sent.has(i.key) && sent.add(i.key));

  const [items, at, to] = transcript.items(id);
  for (const i of items) sent.add(i.key);
  path = at;
  readTo = to;
  const m = await meta(id);
  lastMeta = JSON.stringify(m);
  const row = await agents.liveRow(id, true);
  say({ type: "hello", meta: m, items, working: row.status === "busy" || row.status === "waiting", asks: [], partial: [] });

  // New lines in the transcript, whoever wrote them.
  const readMore = () => {
    if (closed) return;
    const now = transcript.pathOf(id);
    if (now !== path) { // a move goes on in the new folder's transcript
      path = now;
      readTo = 0;
      watchFile();
    }
    if (!path) return;
    const [entries, next] = transcript.read(path, readTo);
    readTo = next;
    const added = fresh(entries.flatMap(transcript.itemsOf));
    if (added.length) say({ type: "items", items: added });
  };
  let timer: NodeJS.Timeout | null = null;
  const soon = () => {
    if (!timer) timer = setTimeout(() => { timer = null; readMore(); }, 40);
  };
  const watchFile = () => {
    file?.close();
    file = null;
    if (path) {
      try {
        file = watch(path, soon);
      } catch {
        // gone again
      }
    }
  };
  watchFile();

  // The host's stream: the words as they come, whether it works, its questions. Joined whenever the host holds the
  // session, which it may take in later, with the panel's first message.
  const joinHost = () => {
    if (host || closed) return;
    const h = hosted.events(id);
    host = h;
    h.on("message", (data) => {
      const e = JSON.parse(data.toString());
      if (e.type === "hello") say({ type: "working", working: e.working, since: e.since, asks: e.asks, partial: e.partial, tasks: e.tasks ?? [], status: e.status ?? null });
      else if (e.type === "message") {
        const added = fresh(transcript.itemsOf(e.entry));
        if (added.length) say({ type: "items", items: added });
      } else if (e.type === "closed") {
        say({ type: "tasks", tasks: [] }); // they ended with its process
        h.close();
      } else say(e);
    });
    h.on("close", () => {
      if (host === h) host = null;
      soon();
    });
    h.on("error", () => {
      if (host === h) host = null;
    });
  };
  if (row.kind === "host") joinHost();

  // Now and then: whether the host took the session in, or a session in the daemon or a terminal works, and whether
  // its title, folder or issue changed.
  const tick = setInterval(async () => {
    try {
      const r = await agents.liveRow(id);
      if (r.kind === "host") joinHost();
      else say({ type: "working", working: r.status === "busy" });
      const next = await meta(id);
      const text = JSON.stringify(next);
      if (text !== lastMeta) {
        lastMeta = text;
        say({ type: "meta", meta: next });
      }
      soon();
    } catch {
      // the next tick tries again
    }
  }, 1500);

  const end = () => {
    closed = true;
    clearInterval(tick);
    if (timer) clearTimeout(timer);
    file?.close();
    host?.close();
  };
  ws.on("close", end);
  ws.on("error", end);
}

// --- what the panel sends --------------------------------------------------------------------------------------------

export interface Sent {
  text: string;
  images?: { media_type: string; data: string }[];
  uuid?: string; // the panel's, to take it back while it waits
  as?: "chat"; // a new chat's chip set to Chat
}

const waiting = new Map<string, Sent[]>(); // messages for sessions still busy in the daemon, sent once it is idle

// The message as Claude Code reads it: plain text, or blocks when it carries screenshots.
function content(m: Sent): hosted.Content {
  if (!m.images?.length) return m.text;
  return [...m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    ...(m.text.trim() ? [{ type: "text", text: m.text }] : [])];
}

// Send the user's message. A session still at work in Claude Code's daemon, from before the panel, takes no message
// mid-turn: the message waits here until its turn ends, then the host takes the session in with it.
export async function send(id: string, m: Sent): Promise<{ queued: boolean }> {
  // A new chat's first message: @name as its first words makes it that agent's (chats.ts, becomeAgent), and the chip
  // set to Chat makes it bare (becomeBare).
  const chat = chats.agentChatOf(id), fresh = chat && chats.empty(chat);
  const tag = fresh ? /^@([\w.-]+)(?:\s|$)/.exec(m.text.trim()) : null;
  const agent = tag && roster.find(tag[1]);
  if (agent) {
    await chats.becomeAgent(chat!, agent, content(m));
    return { queued: false };
  }
  if (fresh && m.as === "chat") {
    await chats.becomeBare(chat!, content(m));
    return { queued: false };
  }
  try {
    await agents.tell(id, content(m), m.uuid);
    return { queued: false };
  } catch (error) {
    if (!(error instanceof agents.Busy)) throw error;
  }
  const list = waiting.get(id);
  if (list) {
    list.push(m);
    return { queued: true };
  }
  waiting.set(id, [m]);
  void (async () => {
    try {
      while ((await agents.liveRow(id, true)).status === "busy") await new Promise((r) => setTimeout(r, 2000));
      const all = waiting.get(id) ?? [];
      waiting.delete(id);
      const text = all.map((x) => x.text).filter(Boolean).join("\n\n");
      await agents.tell(id, content({ text, images: all.flatMap((x) => x.images ?? []) }));
    } catch (error) {
      waiting.delete(id);
      console.error(`desk: could not send to ${id}: ${error}`);
    }
  })();
  return { queued: true };
}

// Take back a message Claude has not read yet (the composer's ↑): true when it never will.
export async function withdraw(id: string, uuid: string): Promise<boolean> {
  const list = waiting.get(id), at = list?.findIndex((m) => m.uuid === uuid) ?? -1;
  if (at >= 0) {
    list!.splice(at, 1);
    return true;
  }
  return Boolean(await hosted.holds(id)) && hosted.withdraw(id, uuid);
}

export async function interrupt(id: string) {
  if (await hosted.holds(id)) return void (await hosted.interrupt(id));
  const row = await agents.liveRow(id, true);
  if (row.status === "busy") throw new Error("This turn runs outside desk's panel, so stop it where it runs.");
}

export const answer = (id: string, ask: string, result: Record<string, unknown>) => hosted.answer(id, ask, result);

// How full the session's context is, for the model chip's menu; null while no process holds it, when none is loaded.
export async function context(id: string) {
  return (await hosted.holds(id)) ? hosted.context(id) : null;
}

// --- what the composer completes ------------------------------------------------------------------------------------

const lists = new Map<string, [number, string[]]>(); // folder: when its files were listed, and them

function filesIn(cwd: string): Promise<string[]> {
  const known = lists.get(cwd);
  if (known && Date.now() - known[0] < 30_000) return Promise.resolve(known[1]);
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      let files = error ? [] : stdout.split("\n").filter(Boolean);
      if (error) { // not a git repo: what lies two levels down
        try {
          for (const a of readdirSync(cwd)) {
            if (a.startsWith(".")) continue;
            files.push(a);
            if (statSync(join(cwd, a)).isDirectory()) for (const b of readdirSync(join(cwd, a)).slice(0, 200)) files.push(`${a}/${b}`);
          }
        } catch {
          files = [];
        }
      }
      lists.set(cwd, [Date.now(), files]);
      resolve(files);
    });
  });
}

// The session's files whose path holds every word of the query, the shortest paths first.
export async function files(id: string, q: string): Promise<string[]> {
  const cwd = (await meta(id)).cwd;
  if (!cwd || !existsSync(cwd)) return [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (await filesIn(cwd)).filter((f) => words.every((w) => f.toLowerCase().includes(w)))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, 30);
}

interface Command { name: string; description: string }

// Skills in a skills folder: each one's name and the first line of its description.
function skillsIn(dir: string): Command[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) return [];
    const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const description = /^description:\s*(.*)$/m.exec(head)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
    return [{ name, description }];
  });
}

// The slash commands and skills the session takes: the host's own list while it holds the session, else the skills on
// disk, the user's and the folder's.
export async function commands(id: string): Promise<Command[]> {
  if (await hosted.holds(id)) {
    try {
      return (await hosted.commands(id)).map((c) => ({ name: c.name, description: c.description }));
    } catch {
      // closed meanwhile
    }
  }
  const cwd = (await meta(id)).cwd;
  const had = new Set<string>();
  return [...skillsIn(join(cwd, ".claude", "skills")), ...skillsIn(join(HOME, ".claude", "skills"))]
    .filter((c) => !had.has(c.name) && had.add(c.name));
}
