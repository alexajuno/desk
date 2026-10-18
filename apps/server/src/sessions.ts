// Claude Code's sessions on this laptop (ported from desk/sessions.py): the corner's history menu, which finds any of them
// and opens it in desk's panel, and the sidebar's Other sessions, those running now that work no issue.
//
// Claude Code keeps each session as a transcript, ~/.claude/projects/<the folder it ran in, as a name>/<session>.jsonl,
// one JSON event per line, written as it runs. desk keeps one row per transcript with only what the list shows, saved
// in CACHE, and reads each file again only from where it stopped (on 15 Oct the first scan read 1,662 transcripts in
// 4.0 s into 1 MB of cache, and after it a load took 10 ms). The cache has the same shape as the Python's.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { patternOf } from "./search.ts";
import * as transcripts from "./transcript.ts";
import { ago } from "./when.ts";

export const PROJECTS = join(HOME, ".claude", "projects");
const CACHE = join(HOME, ".cache", "desk", "sessions.json");

interface TableRow {
  id: string;
  path: string;
  read_to: number;
  moved?: number;
  cwd?: string;
  kind?: string;
  first_prompt?: string;
  custom_title?: string;
  agent_name?: string;
  ai_title?: string;
  last_prompt?: string;
}

const table = new Map<string, TableRow>();

// What the user typed in a user event: not a tool's result, nor a slash command's own lines ("<command-name>").
function textOf(event: { message?: { content?: unknown } }): string {
  let content = event.message?.content;
  if (Array.isArray(content)) content = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  const text = String(content ?? "").split(/\s+/).filter(Boolean).join(" ");
  return text.startsWith("<") ? "" : [...text].slice(0, 300).join("");
}

// Read the transcript from where the row stopped, up to its last whole line; a line Claude Code is still writing is
// read next time.
function readRow(row: TableRow) {
  const fd = openSync(row.path, "r");
  const size = statSync(row.path).size;
  const buf = Buffer.alloc(Math.max(0, size - row.read_to));
  readSync(fd, buf, 0, buf.length, row.read_to);
  closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  row.read_to += end;
  let at = 0;
  while (at < end) {
    const nl = buf.indexOf(10, at);
    const line = buf.subarray(at, nl);
    at = nl + 1;
    // Most lines are tool calls and replies; parse only those that may carry what a row keeps.
    if (line.includes('"type":"user"')) {
      if ("first_prompt" in row && "cwd" in row) continue;
    } else if (!['-title"', '"agent-name"', '"last-prompt"'].some((mark) => line.includes(mark))) continue;
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      continue; // a line cut short when its session was killed mid-write
    }
    const kind = event.type;
    if (kind === "user") {
      row.cwd ??= event.cwd;
      row.kind ??= event.entrypoint === "sdk-cli" ? "script" : event.sessionKind === "bg" ? "background" : "terminal";
      if (!("first_prompt" in row) && !event.isMeta) {
        const text = textOf(event);
        if (text) row.first_prompt = text;
      }
    } else if (kind === "custom-title") row.custom_title = event.customTitle;
    else if (kind === "agent-name") row.agent_name = event.agentName;
    else if (kind === "ai-title") row.ai_title = event.aiTitle;
    else if (kind === "last-prompt") row.last_prompt = [...String(event.lastPrompt ?? "").split(/\s+/).filter(Boolean).join(" ")].slice(0, 300).join("");
  }
}

// Where a session's talk stands, from its transcript alone, open or closed: when the user last wrote, a message typed
// in its chat or one desk sent for them, such as Approve's (both carry "origin": {"kind": "human"}), and when its last
// reply ended ("stop_reason": "end_turn"). Read from where it stopped, as the table is; a chat desk moved writes on in
// its new folder's file, which is read from its start.
interface Talk { path: string; read: number; prompted: number | null; replied: number | null }
const talks = new Map<string, Talk>();

function talk(session: string): Talk | null {
  const path = transcripts.pathOf(session);
  if (!path) return null;
  let t = talks.get(session);
  if (!t) talks.set(session, (t = { path, read: 0, prompted: null, replied: null }));
  if (t.path !== path || statSync(path).size < t.read) [t.path, t.read] = [path, 0];
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.max(0, size - t.read));
  readSync(fd, buf, 0, buf.length, t.read);
  closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  t.read += end;
  let at = 0;
  while (at < end) {
    const nl = buf.indexOf(10, at);
    const line = buf.subarray(at, nl);
    at = nl + 1;
    const human = line.includes('"origin":{"kind":"human"}');
    if (!human && !line.includes('"stop_reason":"end_turn"')) continue;
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (!event.timestamp) continue;
    const when = new Date(event.timestamp).getTime() / 1000;
    if (human && event.type === "user" && !event.isMeta && textOf(event)) t.prompted = when;
    else if (event.type === "assistant" && event.message?.stop_reason === "end_turn") t.replied = when;
  }
  return t;
}

// When the user last wrote to the session, and when its last reply ended, in seconds.
export const prompted = (session: string): number | null => talk(session)?.prompted ?? null;
export const replied = (session: string): number | null => talk(session)?.replied ?? null;

// A turn writes to its transcript at each step; one silent this long stopped short of its reply (killed by a reboot,
// or the host stopped under it). A long Bash call runs at most 10 minutes, Claude Code's own limit.
const QUIET = 15 * 60_000;

// Whether the session works on your last message: no reply has ended since, and its transcript moved in the last
// QUIET. Its transcript alone says so, so a chat the host closed, or one never started, is not working.
export function working(session: string): boolean {
  const t = talk(session);
  if (!t?.prompted || (t.replied ?? 0) >= t.prompted) return false;
  return Date.now() - statSync(t.path).mtimeMs < QUIET;
}

// The session table, brought up to date with the transcripts.
export function refresh(): Map<string, TableRow> {
  if (!table.size && existsSync(CACHE)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, TableRow>)) table.set(k, v);
    } catch {
      // a cache cut short: build it again
    }
  }
  const seen = new Set<string>();
  let changed = false;
  for (const dir of existsSync(PROJECTS) ? readdirSync(PROJECTS) : []) {
    let names: string[];
    try {
      names = readdirSync(join(PROJECTS, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(PROJECTS, dir, name), sid = name.slice(0, -6);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seen.add(sid);
      let row = table.get(sid);
      if (row && row.read_to === stat.size) continue;
      if (!row || stat.size < row.read_to) { // new, or written anew
        row = { id: sid, path, read_to: 0 };
        table.set(sid, row);
      }
      readRow(row);
      row.moved = stat.mtimeMs / 1000;
      changed = true;
    }
  }
  for (const sid of [...table.keys()]) if (!seen.has(sid)) { table.delete(sid); changed = true; }
  if (changed) {
    mkdirSync(dirname(CACHE), { recursive: true });
    const temp = CACHE.replace(/\.json$/, ".tmp");
    writeFileSync(temp, JSON.stringify(Object.fromEntries(table)), "utf8");
    renameSync(temp, CACHE);
  }
  return new Map(table);
}

// --- what the corner's history and the sidebar show -------------------------------------------------------------------

// A rename first; then Claude Code's own title; then the title of the issue it works; then the first thing typed. The
// name `-n` gave a session at its start comes last, since desk names its own that way.
export function title(row: TableRow, i: Issue | null = null): string {
  const custom = row.custom_title;
  if (custom && custom !== row.agent_name) return custom;
  return row.ai_title || i?.title || row.first_prompt || custom || "Untitled session";
}

// desk names each session it starts in the host, which keeps the name as the session's title: a chat "desk chat 17 Oct
// 19:24", an issue's its title cut short. Its issue's whole title, or what was first said in it, reads better.
function shown(row: TableRow, i: Issue | null, desks: boolean): string {
  return desks || i ? i?.title || row.ai_title || row.first_prompt || title(row) : title(row);
}

// The session's title as the list shows it, or nothing when it has no transcript yet.
export function titleOf(sid: string): string {
  const row = refresh().get(sid);
  return row ? title(row) : "";
}

// A desk chat's title, as the list shows it: Claude Code's own, or what was first said in it; nothing before that.
export function chatTitleOf(sid: string): string {
  const row = refresh().get(sid);
  return row ? row.ai_title || row.first_prompt || "" : "";
}

// The folder, short: "desk" for ~/projects/desk, "~" for home.
export function folder(cwd: string | undefined): string {
  if (!cwd) return "";
  const path = cwd.replace(/\/+$/, "") || "/";
  if (path === HOME) return "~";
  if (!path.startsWith(`${HOME}/`)) return cwd;
  return path.slice(HOME.length + 1).replace(/^projects\//, "");
}

// Where a session stands, from its row in `claude agents --json --all`: working while a turn runs, waiting while it asks
// you something (blocked), open while its process lives, closed otherwise.
export function state(live: agents.Row): string {
  if (live.status === "busy") return "working";
  if (live.pid) return live.status === "waiting" || live.state === "blocked" ? "waiting" : "open";
  return "closed";
}

// The issue each session works, by session id: an issue's own session, or an agent chat bound to an issue.
async function issuesBySession(): Promise<Map<string, Issue>> {
  const everything = await store.loadAll();
  const found = new Map<string, Issue>();
  for (const i of everything.values()) if (i.session) found.set(i.session, i);
  for (const chat of chats.agentChats()) if (chat.issue && everything.has(chat.issue)) found.set(chat.session, everything.get(chat.issue)!);
  return found;
}

// The sessions, the one that moved last first; with a query, only those whose title, folder, issue or prompts hold
// every word of it, where a word starts.
export async function rows(query = "") {
  const t = refresh(), issues = await issuesBySession(), live = await agents.live();
  const desks = new Set(chats.agentChats().map((c) => c.session));
  const patterns = query.split(/\s+/).filter(Boolean).map((w) => patternOf([w]));
  const found: { id: string; title: string; folder: string; moved: Date; state: string }[] = [];
  for (const row of [...t.values()].sort((a, b) => (b.moved ?? 0) - (a.moved ?? 0))) {
    const sid = row.id, i = issues.get(sid) ?? null, name = shown(row, i, desks.has(sid));
    if (patterns.length) {
      const text = [name, row.cwd, i && `${i.slug} ${i.title}`, row.first_prompt, row.last_prompt].filter(Boolean).join(" ");
      if (!patterns.every((p) => { p.lastIndex = 0; return p.test(text); })) continue;
    }
    found.push({ id: sid, title: name, folder: folder(row.cwd), moved: new Date((row.moved ?? 0) * 1000), state: state(live.get(sid) ?? {}) });
  }
  return found;
}

const RUNNING = join(HOME, ".claude", "sessions"); // Claude Code's <pid>.json for each session whose process lives

// What started the process: "cli" for `claude` in a terminal, "sdk-cli" for `claude -p`, "sdk-ts" for the Agent SDK,
// which desk's host and anything it runs inherit. Claude Code's own state, read from the files on 17 Oct.
function entrypoint(pid: number | undefined): string {
  try {
    return pid && pid > 0 ? JSON.parse(readFileSync(join(RUNNING, `${pid}.json`), "utf8")).entrypoint ?? "" : "";
  } catch {
    return ""; // it ended meanwhile
  }
}

// The sidebar's Other sessions: those running now that work no issue, such as a `claude` started in a terminal or one
// opened from the corner's history, the newest first. Not a script (`claude -p`), which ends on its own with nobody to
// talk to it, nor an agent chat nobody has written in yet, nor a chat with one of the user's agents or a bare one,
// which the sidebar lists under Agents and Chats.
export async function others() {
  const issues = await issuesBySession(), mine = new Map(chats.agentChats().map((c) => [c.session, c]));
  const running = new Map<string, agents.Row>();
  for (const row of (await agents.live()).values()) if (row.sessionId && row.pid && !issues.has(row.sessionId)) running.set(row.sessionId, row);
  const found: { id: string; title: string; folder: string; state: string; started: number }[] = [];
  const t = running.size ? refresh() : table;
  for (const [sid, row] of running) {
    const chat = mine.get(sid), kept = t.get(sid);
    if (chat?.agent || chat?.bare || (chat ? chats.said(chat).next().done : entrypoint(row.pid) === "sdk-cli")) continue;
    found.push({ id: sid, title: (kept && shown(kept, null, Boolean(chat))) || row.name || "Untitled session", folder: folder(row.cwd), state: state(row), started: Number(row.startedAt ?? 0) });
  }
  return found.sort((a, b) => b.started - a.started);
}

// --- opening one -----------------------------------------------------------------------------------------------------

// Ctrl Shift O and New session: an agent chat in desk's panel. One nobody has written in yet is reused, so empty chats
// never pile up and none is ever removed: desk's reaper used to remove them, and on 17 Oct a restart, which forgot the
// open panels, took one while the user wrote its first message ("Its folder is gone").
export async function newSession(base: string): Promise<chats.Chat> {
  return chats.agentChats().find(chats.empty) ?? (await chats.newChat(base));
}

// The corner's history menu: the newest sessions, or those matching what is typed.
export async function recent(q: string) {
  return (await rows(q)).slice(0, 30).map((r) => ({ id: r.id, title: r.title, folder: r.folder, state: r.state, age: ago(r.moved) }));
}
