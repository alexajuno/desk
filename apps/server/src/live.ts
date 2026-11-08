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
//     {"type": "meta", "meta": <meta>}                           its title, folder, issue, model, effort or usage changed
//
// An <item> is transcript.ts's. The app sends {"type": "visible", "visible": true} as its tab shows or hides, so desk
// knows whether the user reads a chat's reply as it comes (the Inbox then leaves it out).
//
// While the host holds the session, its stream says everything as it happens but the user's own messages, which only
// the transcript says: before each new block or message from the stream, the panel reads what the transcript gained,
// so a message comes before its reply (give). The rest a panel looks at again when desk says something moved (moved):
// a write that changed a row, such as the chat's title or the session's model, or the host's word that the session's
// turn started or ended, or that the host took it in. It then reads what the transcript gained, which the host's stream
// may have missed, as across a restart. A session the host does not hold, such as one in a terminal, shows what its
// transcript held when the panel opened and when desk last looked.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import * as agents from "./agents.ts";
import * as auto from "./auto.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as hosted from "./hosted.ts";
import * as inbox from "./inbox.ts";
import * as store from "./issues.ts";
import * as models from "./models.ts";
import * as roster from "./roster.ts";
import * as transcript from "./transcript.ts";
import type { Item } from "./transcript.ts";
import * as turns from "./turns.ts";
import * as uploads from "./uploads.ts";

export const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const visible = new Map<WebSocket, string>(); // the panels showing now, and their sessions
const panels = new Map<WebSocket, [string, () => void]>(); // each open panel's session, and its look again

// Something an open panel shows may have moved: the sessions named, or null for any (sync.ts). Each of their panels
// looks again.
export function moved(sessions: string[] | null) {
  for (const [id, look] of panels.values()) if (!sessions || sessions.includes(id)) look();
}

// A new count of a session's context moves its panels.
models.onCounted((session) => moved([session]));

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
  auto: boolean; // Auto in its composer, rather than Manual (chats.ts, setAuto)
  picked: boolean; // a new chat's folder, picked in its composer (chats.ts, startIn)
  runs: models.Shown & { fresh: boolean; picking: boolean }; // the model and effort, for the composer's chip; fresh: the first message can still pick them (chats.ts, canPick); picking: it will (picksFirst)
  usage: ReturnType<typeof models.outright>; // the context, the 5 hours and the week, shown outright in the composer
}

const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

export async function meta(id: string): Promise<Meta> {
  const chat = chats.agentChatOf(id);
  const all = await store.shown();
  // The chat's own issue: the first issue naming the session took a done issue a chat had left for its next (29 Oct).
  const issue = (chat?.issue && all.get(chat.issue)) || null;
  const row = await agents.shownRow(id);
  // A chat the host runs is where desk last started it: a listing from before its composer picked a folder still names
  // the old one (26 Oct). A process of the user's own, such as one resumed in a terminal, is where it runs.
  const cwd = (chat && (!row.cwd || row.kind === "host") ? chats.runsIn(chat) : row.cwd ?? transcript.cwdOf(id)) ?? "";
  const { chatTitleOf, titleOf } = await import("./sessions.ts");
  return {
    id, cwd, folder: tilde(cwd), chat: Boolean(chat), agent: chat?.agent ?? null, bare: Boolean(chat?.bare), auto: Boolean(chat?.auto),
    picked: Boolean(chat?.cwd && !chat.issue && !chat.agent && !chat.bare), // a bound chat's cwd is its issue's folder
    // A bare chat by the title the sidebar's Chats give it, not by the name desk started its session with; any chat by
    // the user's own title.
    title: issue?.title || chat?.named || (chat?.bare ? chatTitleOf(id) : "") || (chat && chat.title !== "New chat" ? chat.title : "") || titleOf(id) || "New session",
    issue: issue ? { slug: issue.slug, title: issue.title, state: issue.state } : null,
    runs: { ...models.shown(id, Boolean(chat)), fresh: Boolean(chat && chats.canPick(chat)), picking: Boolean(chat && chats.picksFirst(chat)) },
    usage: models.outright(id),
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
  let path: string | null = null, readTo = 0, host: WebSocket | null = null, closed = false;
  const opened = Date.now();
  let lastMeta = "";
  const say = (event: Record<string, unknown>) => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const fresh = (items: Item[]) => items.filter((i) => !sent.has(i.key) && sent.add(i.key));

  const [items, at, to] = transcript.items(id);
  for (const i of items) sent.add(i.key);
  path = at;
  readTo = to;
  models.context(id); // counted again when a turn ran since the last count, which comes as a meta
  const m = await meta(id);
  lastMeta = JSON.stringify(m);
  say({ type: "hello", meta: m, items, working: turns.working(id), asks: [], partial: [] });

  // The transcript's new lines, whoever wrote them, until the panel is given them (give).
  let unread: transcript.Entry[] = [];
  let streaming = false; // a turn runs in the host's stream the panel has joined, which sends Claude's own entries

  // Give the panel what the transcript gained, in its order. While a turn streams, Claude's entries come from the host's
  // stream, after their streamed words: one the stream has not sent yet waits for it, and so does what follows it, which
  // would otherwise come ahead of the reply's next block, drawn twice once it streams.
  const give = () => {
    const added: Item[] = [];
    let n = 0;
    for (; n < unread.length; n++) {
      const items = transcript.itemsOf(unread[n]);
      if (streaming && unread[n].type === "assistant" && items.some((i) => !sent.has(i.key))) break;
      added.push(...fresh(items));
    }
    unread = unread.slice(n);
    if (added.length) say({ type: "items", items: added });
  };

  const readMore = () => {
    if (closed) return;
    const now = transcript.pathOf(id);
    if (now !== path) { // a move goes on in the new folder's transcript
      path = now;
      readTo = 0;
    }
    if (path) {
      const [entries, next] = transcript.read(path, readTo);
      readTo = next;
      unread.push(...entries);
      // A /model or /effort typed since the panel opened, which the chip shows as its own picks once kept. An older one,
      // read again as a moved chat's transcript is read from its start, is left: the chip may have picked over it since.
      for (const e of entries) {
        const run = Date.parse(e.timestamp) >= opened && transcript.commandRun(e);
        if (run) void models.ran(id, run).catch((error) => console.error(`desk: ${id} ran /${run.command}`, error));
      }
    }
    give();
  };
  let timer: NodeJS.Timeout | null = null;
  const soon = () => {
    if (!timer) timer = setTimeout(() => { timer = null; readMore(); }, 40);
  };

  // The host's stream: the words as they come, whether it works, its questions. Joined whenever the host holds the
  // session, which it may take in later, with the panel's first message.
  const joinHost = () => {
    if (host || closed) return;
    const h = hosted.events(id);
    host = h;
    h.on("message", (data) => {
      const e = JSON.parse(data.toString());
      // What the transcript gained goes first, such as the user's message this reply answers, which the stream never
      // says: read only once the reply came, it was drawn below it (20 Oct). A piece of a block streaming adds nothing.
      // The stream sends none of what finished before its hello, nor any more of a turn once it ends.
      if (e.type === "hello") {
        streaming = false;
        readMore();
        streaming = Boolean(e.working);
        return say({ type: "working", working: e.working, since: e.since, asks: e.asks, partial: e.partial, tasks: e.tasks ?? [], status: e.status ?? null });
      }
      if (e.type === "working") streaming = Boolean(e.working);
      if (e.type !== "stream" || !e.text) readMore();
      if (e.type === "message") {
        const added = fresh(transcript.itemsOf(e.entry));
        if (added.length) say({ type: "items", items: added });
        give(); // what the transcript holds after it
        if (e.entry.local_command_run) soon(); // a slash command ran: its record in the transcript tells a /model's pick
      } else if (e.type === "closed") {
        say({ type: "tasks", tasks: [] }); // they ended with its process
        h.close();
      } else say(e);
    });
    const left = () => {
      if (host !== h) return;
      host = null;
      streaming = false;
    };
    h.on("close", () => {
      left();
      soon();
    });
    h.on("error", left);
  };
  if (await turns.hosting(id)) joinHost();

  // Whether the host took the session in, and whether its title, folder, issue or model changed: one look at a time,
  // and one more after it when told meanwhile.
  let looking: Promise<void> | null = null, again = false;
  const look = () => {
    if (closed) return;
    if (looking) {
      again = true;
      return;
    }
    looking = (async () => {
      do {
        again = false;
        try {
          if (await turns.hosting(id)) joinHost();
          const next = await meta(id);
          const text = JSON.stringify(next);
          if (text !== lastMeta) {
            lastMeta = text;
            say({ type: "meta", meta: next });
          }
          soon();
        } catch (error) {
          console.error(`desk: the panel of ${id}`, error); // the next change looks again
        }
      } while (again && !closed);
      looking = null;
    })();
  };
  panels.set(ws, [id, look]);
  look(); // what moved while it said hello

  const end = () => {
    closed = true;
    panels.delete(ws);
    if (timer) clearTimeout(timer);
    host?.close();
  };
  ws.on("close", end);
  ws.on("error", end);
}

// --- what the panel sends --------------------------------------------------------------------------------------------

export interface Sent {
  text: string;
  images?: { media_type: string; data: string }[];
  files?: uploads.Upload[]; // attached files Claude takes by path (uploads.ts)
  uuid?: string; // the panel's, to take it back while it waits
  as?: "chat"; // a new chat's chip set to Chat
  now?: boolean; // Ctrl+Enter: Claude reads it at once, as Claude Code's send now
}

const waiting = new Map<string, Sent[]>(); // messages for sessions still busy in the daemon, sent once it is idle

// The message as Claude Code reads it: plain text, or blocks when it carries screenshots.
function content(m: Sent): hosted.Content {
  if (!m.images?.length) return m.text;
  return [...m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    ...(m.text.trim() ? [{ type: "text", text: m.text }] : [])];
}

// Coming back to a long chat compacts it before your message, so that your message and every reply after it re-read a
// short context rather than the whole conversation (the user, 28 Oct, on the issue "Compact a desk chat when you come
// back after an hour or it passes 300k"). After an hour away the prompt cache, which desk's sessions keep for an hour,
// has expired, and the whole context would be written to it again anyway. Until 30 Oct any message to a chat over 300k
// compacted it too, which put a compaction of about 76 s in front of a message just typed, and asked again on the next
// one when you cancelled it: "300k is kinda a hard cap without caring what's going on" (the user, 30 Oct). This one stays, as
// the budget plan leans on it; a break in the work compacts a chat as its turn ends instead (compact.ts).
const AWAY = 3600; // seconds since the chat's last turn ended
const OVER = 100_000; // tokens a chat holds for coming back to compact it

// Only a message you type, between turns: not a command of your own, nor one sent to the turn running now.
function compactsFirst(id: string, m: Sent): boolean {
  if (m.now || turns.working(id) || /^\/[\w:-]+(\s|$)/.test(m.text.trim())) return false;
  const ended = turns.ended(id);
  if (ended === null || Date.now() / 1000 - ended <= AWAY) return false;
  return (models.context(id)?.tokens ?? 0) > OVER;
}

// Send the user's message. A session still at work in Claude Code's daemon, from before the panel, takes no message
// mid-turn: the message waits here until its turn ends, then the host takes the session in with it.
export async function send(id: string, sent: Sent): Promise<{ queued: boolean }> {
  const { files = [], ...m } = sent;
  m.text = uploads.attach(id, m.text ?? "", files);
  // A new chat's first message: @name as its first words makes it that agent's (chats.ts, becomeAgent), and the chip
  // set to Chat makes it bare (becomeBare).
  const chat = chats.agentChatOf(id), fresh = chat && chats.empty(chat);
  const tag = fresh ? /^@([\w.-]+)(?:\s|$)/.exec(m.text.trim()) : null;
  const agent = tag && roster.find(tag[1]);
  if (agent) {
    await chats.becomeAgent(chat!, agent, content(m));
    moved([id]);
    return { queued: false };
  }
  if (fresh) await chats.pickFirst(chat!, m.text);
  if (fresh && m.as === "chat") {
    await chats.becomeBare(chat!, content(m));
    moved([id]);
    return { queued: false };
  }
  if (compactsFirst(id, m)) {
    try {
      await agents.tell(id, "/compact"); // the host's inbox reads it first, then the message below
    } catch (error) {
      if (!(error instanceof agents.Busy)) throw error; // still busy in the daemon: the message waits below, uncompacted
    }
  }
  try {
    await agents.tell(id, content(m), m.uuid, m.now);
    moved([id]); // the host holds it now: its panels join its stream
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
  // Only Claude Code knows when a turn in its daemon ends, so desk asks it, while a message waits on one.
  void (async () => {
    try {
      while ((await agents.liveRow(id, true)).status === "busy") await new Promise((r) => setTimeout(r, 2000));
      const all = waiting.get(id) ?? [];
      waiting.delete(id);
      const text = all.map((x) => x.text).filter(Boolean).join("\n\n");
      await agents.tell(id, content({ text, images: all.flatMap((x) => x.images ?? []) }));
      moved([id]);
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
  auto.stop(id); // Stop stops Auto too: the turn waits for the user
  if (await hosted.holds(id)) return void (await hosted.interrupt(id));
  const row = await agents.liveRow(id, true);
  if (row.status === "busy") throw new Error("This turn runs outside desk's panel, so stop it where it runs.");
}

export const answer = (id: string, ask: string, result: Record<string, unknown>) => hosted.answer(id, ask, result);

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

// The commands the composer lists in any chat, held by the host or not: /model and /effort it runs itself (Dock.tsx,
// runsIn), and /compact it sends on, so that the name is marked before a first turn starts the host. Worded as Claude
// Code lists them.
const COMPOSERS: Command[] = [
  { name: "compact", description: "Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarizing]" },
  { name: "model", description: "Set the AI model for Claude Code" },
  { name: "effort", description: "Set effort level for model usage" },
];

// The slash commands and skills the session takes: the host's own list while it holds the session, else the skills on
// disk, the user's and the folder's, with the composer's own /model and /effort and /compact.
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
  return [...skillsIn(join(cwd, ".claude", "skills")), ...skillsIn(join(HOME, ".claude", "skills")), ...COMPOSERS]
    .filter((c) => !had.has(c.name) && had.add(c.name));
}
