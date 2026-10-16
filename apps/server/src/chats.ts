// desk's agent (ported from desk/chats.py): a Claude Code session with desk's own skills, which files issues and works them itself,
// in a floating kitty window over desk. It starts in DESK_DATA and reaches desk through curl to its API. Work on an issue
// is done in the chat: the chat binds itself to the issue (POST /api/issues/<slug>/work), which makes the chat's session
// the issue's session, and desk then moves the chat into the issue's folder, so that Claude Code loads that folder's
// CLAUDE.md, rules, skills, agents and settings.
//
// A chat is a JSON file in DESK_DATA/chats/.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import * as agents from "./agents.ts";
import { CHATS_DIR, DATA_DIR, HOME, REPO } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { run, which } from "./proc.ts";
import { fill, MOVED, NOT_MOVED, PLAN_RULES, PROMPT, PROTOCOLS, REATTACH, UNTRUSTED, WINDOW_FLAGS, WINDOW_RULES, WORK } from "./prompts.ts";
import * as window from "./window.ts";

const SKILL = join(REPO, "skill", "SKILL.md");
const SKILL_BASE = "http://127.0.0.1:8790"; // the address SKILL.md is written for; each chat swaps in its own

export interface Chat {
  id: string;
  kind?: string;
  title: string;
  created: string;
  updated?: string;
  session: string;
  messages: unknown[];
  issue?: string;
  folder?: string;
  cwd?: string;
  [key: string]: unknown;
}

export class NoChat extends Error {}

const CHAT_ID = /^[a-z0-9-]{1,80}$/;

function path(id: string): string {
  if (!CHAT_ID.test(id) || !existsSync(join(CHATS_DIR, `${id}.json`))) throw new NoChat("No such chat");
  return join(CHATS_DIR, `${id}.json`);
}

export const load = (id: string): Chat => JSON.parse(readFileSync(path(id), "utf8"));

const now = () => store.now();

// Python's json.dumps(chat, indent=1, ensure_ascii=False), so a chat file reads the same whichever wrote it.
function pyJson(value: unknown, indent = 1, depth = 0): string {
  const pad = (d: number) => "\n" + " ".repeat(indent * d);
  if (Array.isArray(value)) return value.length ? `[${value.map((v) => pad(depth + 1) + pyJson(v, indent, depth + 1)).join(",")}${pad(depth)}]` : "[]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? `{${entries.map(([k, v]) => `${pad(depth + 1)}${JSON.stringify(k)}: ${pyJson(v, indent, depth + 1)}`).join(",")}${pad(depth)}}` : "{}";
  }
  return JSON.stringify(value) ?? "null";
}

export function save(chat: Chat) {
  mkdirSync(CHATS_DIR, { recursive: true });
  chat.updated = now();
  writeFileSync(join(CHATS_DIR, `${chat.id}.json`), pyJson(chat), "utf8");
}

export const exists = (id: string) => CHAT_ID.test(id) && existsSync(join(CHATS_DIR, `${id}.json`));

// The chat as plain text, the user's words and the agent's replies in order, for a session's first prompt.
export function transcript(id: string): string {
  const names: Record<string, string> = { user: "The user", assistant: "desk's agent" };
  return [...said(load(id))].map(([who, text]) => `${names[who]}: ${text}`).join("\n\n");
}

// The chat becomes the issue's session, and desk moves it into the issue's folder once its turn ends. An issue in
// Triage has no folder yet, so the chat stays where it runs.
export function bind(chat: Chat, i: Issue, base: string) {
  chat.issue = i.slug;
  chat.folder = i.folder ? resolve(agents.workdir(i)) : runsIn(chat);
  save(chat);
  if (!same(chat.folder, runsIn(chat)) && !MOVING.has(chat.id)) {
    MOVING.add(chat.id);
    void move(chat.id, base);
  }
}

// The agent's system prompt, given when the chat's session starts and when desk moves it, since Claude Code keeps the
// one it was started with.
export async function agentPrompt(chat: Chat, base: string): Promise<string> {
  const reference = readFileSync(SKILL, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replaceAll(SKILL_BASE, base);
  const slug = chat.issue;
  const folder = slug && (await store.exists(slug)) ? store.folder(slug) : "<the issue's folder>";
  const work = fill(WORK, { dir: folder, file: join(folder, "issue.md"), plan: join(folder, "plan.md") });
  const rules = Object.fromEntries(Object.entries(WINDOW_RULES).map(([k, v]) => [k, fill(v, { base })]));
  // A chat may run for days, and Claude Code gives it the date.
  let prompt = fill(PROMPT, { today: "the date your environment gives", day: "15 Oct", reference, chat: chat.id, plan_rules: PLAN_RULES, work,
    protocols: fill(PROTOCOLS, { plan: join(folder, "plan.md") }), ...rules });
  if (slug) prompt += `\n\nThis chat works the issue /issue/${slug}, in ${chat.folder}.`;
  return prompt;
}

// --- chats in a window -------------------------------------------------------------------------------------------
// A window chat is a Claude Code background session desk starts in DESK_DATA with the agent's prompt, shown in a
// floating kitty window Hyprland opens over desk (chats.py, in git history, said what was checked, 15 Oct).

const WINDOW = "window";
// Where Claude Code keeps the transcripts of the sessions started in DESK_DATA: the folder's path, each character other
// than a letter or a digit made "-".
const TRANSCRIPTS = join(HOME, ".claude", "projects", DATA_DIR.replace(/[^A-Za-z0-9]/g, "-"));

// Start a window chat's session, idle until the user types in its window. started hears the session's short id, which
// `claude attach` takes, as soon as Claude Code prints it.
export async function newWindowChat(base: string, id = newChatId(), started?: (short: string) => void): Promise<Chat> {
  // strftime's %b in the C locale: Sep, never Sept.
  const d = new Date(), month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const chat: Chat = { id, kind: WINDOW, title: "New chat", created: now(), session: "", messages: [] };
  const name = `desk chat ${d.getDate()} ${month} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const short = await agents.background(DATA_DIR, ["claude", "--bg", "-n", name, ...WINDOW_FLAGS, "--append-system-prompt", await agentPrompt(chat, base)]);
  started?.(short);
  chat.session = await agents.sessionId(short);
  save(chat);
  return chat;
}

const newChatId = () => `chat-${randomBytes(4).toString("hex")}`;

// A new chat's window waits, up to a minute, for its session's short id in the file $2, then attaches as REATTACH does;
// an empty file, left when Claude Code did not start the session, closes it.
const AWAIT_ATTACH = `i=0; while [ ! -e "$2" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; id=$(cat "$2" 2>/dev/null); rm -f "$2"; [ -n "$id" ] || exit 1; set -- "$1" "$id" "$3"; ${REATTACH}`;

// Ctrl Shift O's new chat, whose window opens at once instead of after `claude --bg` has started the session (about
// 0.7 s), and attaches as soon as it has.
export async function openNewWindowChat(base: string): Promise<Chat> {
  const id = newChatId(), handoff = join(tmpdir(), `desk-${id}.session`);
  const hand = (short: string) => {
    writeFileSync(`${handoff}.part`, short);
    renameSync(`${handoff}.part`, handoff); // whole, so the window never reads it half written
  };
  const starting = newWindowChat(base, id, hand).catch((error) => {
    hand("");
    throw error;
  });
  const opening = window.launch(`desk-agent-${id}`, "desk · New chat", DATA_DIR, ["sh", "-c", AWAIT_ATTACH, "sh", which("claude") ?? "claude", handoff, moving(id)]);
  return (await Promise.all([starting, opening]))[0];
}

// The user's words and the agent's, in order, from a window chat's transcript.
export function* said(chat: Chat): Generator<[string, string]> {
  const file = join(TRANSCRIPTS, `${chat.session}.jsonl`);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a line Claude Code is still writing
    }
    if (!["user", "assistant"].includes(event.type) || event.isMeta) continue;
    const content = event.message.content;
    const text: string = typeof content === "string" ? content
      : content.filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n");
    if (text.trim() && !text.trimStart().startsWith("<")) yield [event.type, text.trim()]; // a tool result, or a slash command's own lines
  }
}

// When a window chat last moved: its transcript's last write, or its start.
export function activity(chat: Chat): string {
  const file = join(TRANSCRIPTS, `${chat.session}.jsonl`);
  if (!existsSync(file)) return chat.created;
  const d = statSync(file).mtime, pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// The chat's window, brought to the user or opened: `claude attach` while its session lists, which also wakes a
// stopped one, else `claude --resume`. An open window comes forward before desk asks Claude Code about the session.
export async function openWindow(chat: Chat, title = "") {
  const name = `desk-agent-${chat.id}`;
  if (await window.focus(name)) return;
  const row = await agents.liveRow(chat.session, true);
  if (row.kind === "interactive") throw new Error("This chat is open in another terminal. Close that one first.");
  const argv = row.kind === "background"
    ? ["sh", "-c", REATTACH, "sh", which("claude") ?? "claude", row.id!, moving(chat.id)]
    : ["claude", "--resume", chat.session];
  await window.launch(name, `desk · ${title || chat.title}`, runsIn(chat), argv);
}

function chats(): Chat[] {
  if (!existsSync(CHATS_DIR)) return [];
  return readdirSync(CHATS_DIR).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(CHATS_DIR, n), "utf8")));
}

// The window chat whose session this is, if any.
export async function windowOf(session: string | null | undefined): Promise<Chat | null> {
  return session ? chats().find((c) => c.kind === WINDOW && c.session === session) ?? null : null;
}

// Whether the window chat whose session this is sits in front, where the user reads its reply as it comes.
export async function readNow(session: string | null | undefined): Promise<boolean> {
  const chat = await windowOf(session);
  if (!chat) return false;
  try {
    return (await window.inFront()) === `desk-agent-${chat.id}`;
  } catch {
    return false; // no Hyprland, so no window in front
  }
}

// The folder the chat's session runs in: DESK_DATA, where every chat starts, until desk moves it.
export const runsIn = (chat: Chat) => chat.cwd || DATA_DIR;

// The folder a chat's session runs in, when the session is a chat's.
export async function sessionRunsIn(session: string | null | undefined): Promise<string | null> {
  const chat = session ? chats().find((c) => c.session === session) : undefined;
  return chat ? runsIn(chat) : null;
}

// The window chats, the one that moved last first.
export function windowChats(): Chat[] {
  return chats().filter((c) => c.kind === WINDOW).sort((a, b) => (activity(a) < activity(b) ? 1 : activity(a) > activity(b) ? -1 : 0));
}

// --- moving a chat -------------------------------------------------------------------------------------------------
// A chat's session loads the folder it runs in, and only that one, so once it binds to an issue in another folder desk
// moves it there, between two turns (chats.py, in git history, said what was checked, 15 Oct).

const MOVING = new Set<string>(); // the chats a move waits on, so a second bind does not start a second move
const MOVE_WAIT = 4 * 3600; // seconds a move waits for the chat's turn to end

// The file that is there while desk moves the chat, holding the folder it moves to.
const moving = (id: string) => join(CHATS_DIR, `${id}.moving`);

function same(a: string, b: string): boolean {
  const real = (p: string) => { const full = resolve(p.startsWith("~") ? join(HOME, p.slice(1)) : p); try { return realpathSync(full); } catch { return full; } };
  return real(a) === real(b);
}

// --add-dir for desk's data folder, which holds the issues' files, unless the chat runs in it.
const adds = (cwd: string) => (same(DATA_DIR, cwd) || !existsSync(DATA_DIR) ? [] : ["--add-dir", DATA_DIR]);

async function move(id: string, base: string) {
  try {
    await carryOver(id, base);
  } catch (error) {
    console.error(`desk: could not move ${id}: ${error}`); // nothing else would see a failure here
  } finally {
    MOVING.delete(id);
  }
}

// Drop Claude Code's record of the chat's session, which also ends it and would otherwise wake it in its old folder, and
// resume it in the issue's folder, telling it to carry on. When the folder will not take it, resume it where it was,
// telling it why. Its window attaches again by itself (REATTACH).
async function carryOver(id: string, base: string) {
  const began = performance.now() / 1000;
  let row: agents.Row;
  while ((row = await agents.liveRow(load(id).session, true)).status === "busy") {
    const waited = performance.now() / 1000 - began;
    if (waited > MOVE_WAIT) return;
    await new Promise((r) => setTimeout(r, waited < 60 ? 200 : 2000)); // the turn usually ends right after the bind
  }
  let chat = load(id);
  if (row.kind === "interactive" || same(chat.folder!, runsIn(chat))) return;
  if (!Object.keys(row).length) { // nothing runs, so the next resume starts it in the folder
    chat.cwd = chat.folder;
    save(chat);
    return;
  }
  const name = `desk-agent-${chat.id}`, i = await store.load(chat.issue!);
  let shown = false;
  try {
    shown = await window.isOpen(name);
  } catch {
    // no Hyprland
  }
  const words = { folder: chat.folder!, title: i.title, base, slug: i.slug };
  writeFileSync(moving(id), chat.folder!, "utf8");
  let moved: boolean;
  try {
    await run(["claude", "rm", row.id!], { timeout: 30 });
    if (row.pid) await agents.exited(row.pid);
    try {
      await resumeIn(chat, row, chat.folder!, fill(MOVED, words), base);
      moved = true;
    } catch (error) {
      const why = error instanceof agents.TrustError ? fill(UNTRUSTED, words) : String((error as Error).message);
      await resumeIn(chat, row, runsIn(chat), fill(NOT_MOVED, { why, ...words }), base);
      moved = false;
    }
  } finally {
    try { unlinkSync(moving(id)); } catch { /* gone */ }
  }
  chat = load(id);
  if (moved) {
    chat.cwd = chat.folder;
    save(chat);
  }
  if (shown && (await window.closed(name, 1))) await openWindow(chat);
}

// Resume the chat's session in the folder with the message, as the same session and with the flags it started with.
async function resumeIn(chat: Chat, row: agents.Row, folder: string, message: string, base: string) {
  const short = await agents.background(folder, ["claude", "--bg", "--resume", chat.session, "-n", row.name || chat.title,
    ...WINDOW_FLAGS, ...adds(folder), "--append-system-prompt", await agentPrompt(chat, base), message]);
  if (!chat.session.startsWith(short)) {
    await run(["claude", "stop", short], { timeout: 30 });
    throw new Error(`Claude Code started a copy (${short}) instead of continuing the session; desk stopped it.`);
  }
}
