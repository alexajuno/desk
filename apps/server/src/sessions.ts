// The Sessions list (ported from desk/sessions.py): every Claude Code session on this laptop in one list, grouped by when each last
// moved, and each opened in desk's panel.
//
// Claude Code keeps each session as a transcript, ~/.claude/projects/<the folder it ran in, as a name>/<session>.jsonl,
// one JSON event per line, written as it runs. desk keeps one row per transcript with only what the list shows, saved
// in CACHE, and reads each file again only from where it stopped (on 15 Oct the first scan read 1,662 transcripts in
// 4.0 s into 1 MB of cache, and after it a load took 10 ms). The cache has the same shape as the Python's.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { markWords, patternOf } from "./search.ts";
import * as views from "./views.ts";
import { ago } from "./when.ts";

export const PROJECTS = join(HOME, ".claude", "projects");
const CACHE = join(HOME, ".cache", "desk", "sessions.json");
export const PAGE = 200; // rows drawn at a time; the list asks for the next ones as you scroll to its end
export const KINDS: Record<string, string> = { terminal: "Terminal", background: "Background", script: "Script" };

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

const prompted_ = new Map<string, [string, number, number | null]>(); // session: its transcript, bytes read, when the user last wrote

// When the user last wrote to the session, in seconds: a message typed in its chat, or one desk sent for them, such as
// Approve's; both carry "origin": {"kind": "human"}. Read from where it stopped, as the table is.
export function prompted(session: string): number | null {
  let entry = prompted_.get(session);
  if (!entry || !existsSync(entry[0]) || statSync(entry[0]).size < entry[1]) {
    const paths = existsSync(PROJECTS) ? readdirSync(PROJECTS).map((d) => join(PROJECTS, d, `${session}.jsonl`)).filter((p) => existsSync(p)) : [];
    if (!paths.length) return null;
    const newest = paths.reduce((a, b) => (statSync(a).mtimeMs >= statSync(b).mtimeMs ? a : b));
    entry = [newest, 0, null];
    prompted_.set(session, entry);
  }
  const fd = openSync(entry[0], "r");
  const size = statSync(entry[0]).size;
  const buf = Buffer.alloc(Math.max(0, size - entry[1]));
  readSync(fd, buf, 0, buf.length, entry[1]);
  closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  entry[1] += end;
  let at = 0;
  while (at < end) {
    const nl = buf.indexOf(10, at);
    const line = buf.subarray(at, nl);
    at = nl + 1;
    if (!line.includes('"origin":{"kind":"human"}')) continue;
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (event.type === "user" && !event.isMeta && textOf(event) && event.timestamp) entry[2] = new Date(event.timestamp).getTime() / 1000;
  }
  return entry[2];
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

// --- what the list shows ---------------------------------------------------------------------------------------------

// A rename first; then Claude Code's own title; then the title of the issue it works; then the first thing typed. The
// name `-n` gave a session at its start comes last, since desk names its own that way.
export function title(row: TableRow, i: Issue | null = null): string {
  const custom = row.custom_title;
  if (custom && custom !== row.agent_name) return custom;
  return row.ai_title || i?.title || row.first_prompt || custom || "Untitled session";
}

// The session's title as the list shows it, or nothing when it has no transcript yet.
export function titleOf(sid: string): string {
  const row = refresh().get(sid);
  return row ? title(row) : "";
}

// The folder, short: "desk" for ~/projects/desk, "~" for home.
export function folder(cwd: string | undefined): string {
  if (!cwd) return "";
  const path = cwd.replace(/\/+$/, "") || "/";
  if (path === HOME) return "~";
  if (!path.startsWith(`${HOME}/`)) return cwd;
  return path.slice(HOME.length + 1).replace(/^projects\//, "");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The time group a session falls in by when it last moved: Today, Yesterday, Last 7 days, Last 30 days, then its month.
export function group(moved: number, today = new Date()): string {
  const day = new Date(moved * 1000);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((midnight(today) - midnight(day)) / 86400000); // whole days, a summer hour either way
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Last 7 days";
  if (diff < 30) return "Last 30 days";
  return day.getFullYear() === today.getFullYear() ? MONTHS[day.getMonth()] : `${MONTHS[day.getMonth()]} ${day.getFullYear()}`;
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

export interface SessionRow {
  id: string;
  title: string;
  marked: string;
  kind: string;
  folder: string;
  cwd: string;
  issue: Issue | null;
  moved: Date;
  group: string;
  state: string;
  group_icon?: string | null;
}

// The sessions to list, the one that moved last first; with a query, only those whose title, folder, issue or prompts
// hold every word of it, where a word starts.
export async function rows(query = "", kind = ""): Promise<SessionRow[]> {
  const t = refresh(), issues = await issuesBySession(), live = await agents.live();
  const patterns = query.split(/\s+/).filter(Boolean).map((w) => patternOf([w]));
  const found: SessionRow[] = [];
  for (const row of [...t.values()].sort((a, b) => (b.moved ?? 0) - (a.moved ?? 0))) {
    if (kind && (row.kind ?? "terminal") !== kind) continue;
    const sid = row.id, i = issues.get(sid) ?? null, name = title(row, i);
    if (patterns.length) {
      const text = [name, row.cwd, i && `${i.slug} ${i.title}`, row.first_prompt, row.last_prompt].filter(Boolean).join(" ");
      if (!patterns.every((p) => { p.lastIndex = 0; return p.test(text); })) continue;
    }
    found.push({ id: sid, title: name, marked: markWords(name, patterns), kind: row.kind ?? "terminal", folder: folder(row.cwd), cwd: row.cwd ?? "",
      issue: i, moved: new Date((row.moved ?? 0) * 1000), group: group(row.moved ?? 0), state: state(live.get(sid) ?? {}) });
  }
  return found;
}

// --- its view: Filter and Display options, as on the issue lists ----------------------------------------------------

const STATES: Record<string, string> = { working: "Working", waiting: "Waiting for you", open: "Open", closed: "Closed" };
const STATE_ICONS: Record<string, string> = { working: "state-running", waiting: "state-review", open: "session-open", closed: "state-backlog" };
const HAS_ISSUE: Record<string, string> = { yes: "Works an issue", no: "No issue" };

function valueOf(row: SessionRow, name: string): string {
  if (name === "status") return row.state;
  if (name === "folder") return row.folder || "none";
  if (name === "issue") return row.issue ? "yes" : "no";
  return row.kind;
}

function labelOf(name: string, v: string): string {
  if (name === "status") return STATES[v] ?? v;
  if (name === "issue") return HAS_ISSUE[v] ?? v;
  if (name === "kind") return KINDS[v] ?? v;
  return v === "none" ? "No folder" : v;
}

function iconOf(name: string, v: string | null): string | null {
  if (name === "status") return STATE_ICONS[v ?? ""] ?? "state-running";
  if (name === "folder") return "glyph-folder";
  return v === null ? "state-backlog" : null; // an issue's circle beside Issue in Filter; none beside yes or no
}

// The rows the view keeps, ordered and grouped. Each group's rows sit together, since the list is drawn a page at a time:
// Last moved and Folder groups come newest first, the others in their own order.
export function arrange(view: views.View, found: SessionRow[]): [views.Listing, SessionRow[]] {
  const kept = found.filter((r) => views.matches(view, (name) => valueOf(r, name)));
  if (view.order === "moved") kept.sort((a, b) => (view.reverse ? a.moved.getTime() - b.moved.getTime() : b.moved.getTime() - a.moved.getTime()));
  else {
    const t = (r: SessionRow) => r.title.toLowerCase();
    kept.sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : 0) * (view.reverse ? -1 : 1));
  }
  if (view.group !== "time") {
    for (const r of kept) {
      const v = view.group === "none" ? "" : valueOf(r, view.group);
      [r.group, r.group_icon] = v ? [labelOf(view.group, v), iconOf(view.group, v)] : ["", null];
    }
  }
  const rank = new Map<string, number>();
  if (view.group === "time" || view.group === "folder") {
    for (const r of [...kept].sort((a, b) => b.moved.getTime() - a.moved.getTime())) if (!rank.has(r.group)) rank.set(r.group, rank.size);
  } else {
    const own = ({ kind: KINDS, status: STATES, issue: HAS_ISSUE } as Record<string, Record<string, string>>)[view.group] ?? {};
    Object.values(own).forEach((name, i) => rank.set(name, i));
  }
  kept.sort((a, b) => (rank.get(a.group) ?? 0) - (rank.get(b.group) ?? 0)); // stable: the order within each group stays

  const valuesOf = (name: string): string[] => {
    if (name === "folder") { // the busiest first: a week of jobs leaves a long tail of one-session folders
      const used = new Map<string, number>();
      for (const r of found) used.set(valueOf(r, "folder"), (used.get(valueOf(r, "folder")) ?? 0) + 1);
      return [...used.keys()].sort((a, b) => used.get(b)! - used.get(a)! || (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    }
    return Object.keys(({ status: STATES, issue: HAS_ISSUE } as Record<string, Record<string, string>>)[name]);
  };
  const { chips, fields } = views.filtering(view, found, valueOf, labelOf, iconOf, valuesOf);
  return [{ view, groups: [], hidden: found.length - kept.length, chips, fields }, kept];
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

// --- telling the page --------------------------------------------------------------------------------------------------
// desk tells the Sessions page when a session starts, moves or changes state: a watcher on the transcripts and the
// background jobs' state, no timer.

const JOBS = join(HOME, ".claude", "jobs");
const DEBOUNCE = 100; // ms a burst of writes is gathered for, so a streaming session costs one check, not one per line
const TRAILING = 1000; // ms after a change, once more: a turn ends with no write apart from the others' (idle)

const listeners = new Set<ServerResponse>();
let signature: string | null = null; // what the list looked like when the pages were last told
let started = false;

// What the list shows, without the ages: the sessions in order, each with its title, state and group.
async function signed(): Promise<string> {
  await agents.live(true);
  return JSON.stringify((await rows()).map((r) => [r.id, r.title, r.state, r.group]));
}

const tell = (message: string) => { for (const res of listeners) res.write(`event: ${message}\ndata: -\n\n`); };

// The process is stopping: end every open event stream (the pages reconnect to the desk that comes next).
export function endStreams() {
  for (const res of listeners) res.end();
  listeners.clear();
}

// Look at the list again and tell the pages if it changed; whether it did.
async function check(): Promise<boolean> {
  if (!listeners.size) {
    signature = null; // a page that connects next draws it afresh
    return false;
  }
  const next = await signed();
  if (next === signature) return false;
  signature = next;
  tell("changed");
  return true;
}

// A transcript written (not a subagent's, a folder deeper), or a background job's state.
const interesting = (path: string) =>
  (path.endsWith(".jsonl") && dirname(dirname(path)) === PROJECTS) || basename(path) === "state.json";

function startWatcher() {
  if (started) return;
  started = true;
  mkdirSync(PROJECTS, { recursive: true });
  mkdirSync(JOBS, { recursive: true });
  let timer: NodeJS.Timeout | null = null, busy = false;
  const fire = async () => {
    timer = null;
    if (busy) return;
    busy = true;
    try {
      let changed = await check();
      while (changed) { // the state a turn ends in shows only a moment after its last write
        await new Promise((r) => setTimeout(r, TRAILING));
        changed = await check();
      }
    } catch (error) {
      console.error("sessions watcher", error);
    } finally {
      busy = false;
    }
  };
  for (const root of [PROJECTS, JOBS]) {
    watch(root, { recursive: true }, (_event, name) => {
      if (!name || !interesting(join(root, name.toString()))) return;
      if (!timer) timer = setTimeout(fire, DEBOUNCE);
    });
  }
}

// Server-sent events: "changed" whenever the list's rows or a state circle changed, "hello" when it connects.
export function events(res: ServerResponse) {
  startWatcher();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write("retry: 1000\nevent: hello\ndata: -\n\n");
  listeners.add(res);
  const alive = setInterval(() => res.write(": still here\n\n"), 20000); // lets a dead socket show up
  res.on("close", () => {
    clearInterval(alive);
    listeners.delete(res);
  });
}
