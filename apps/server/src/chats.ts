// desk's agent (ported from desk/chats.py): a Claude Code session with desk's own skills, which files issues and works them itself,
// in desk's session panel. It starts in DESK_DATA and reaches desk through curl to its API. Work on an issue
// is done in the chat: the chat binds itself to the issue (POST /api/issues/<slug>/work), which makes the chat's session
// the issue's session, and desk then moves the chat into the issue's folder, so that Claude Code loads that folder's
// CLAUDE.md, rules, skills, agents and settings.
//
// A chat is a JSON file in DESK_DATA/chats/.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import * as agents from "./agents.ts";
import { CHATS_DIR, DATA_DIR, HOME, PORT, REPO } from "./config.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as models from "./models.ts";
import { run } from "./proc.ts";
import { fill, MOVED, NOT_MOVED, PLAN_RULES, PROMPT, PROTOCOLS, WINDOW_RULES, WORK } from "./prompts.ts";
import * as settings from "./settings.ts";
import type { Effort } from "./settings.ts";
import * as transcripts from "./transcript.ts";

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

// --- the chats ---------------------------------------------------------------------------------------------------
// A chat is a session in the host (host.ts), started in DESK_DATA with the agent's prompt. Chats from before the panel
// (kind "window") ran in Claude Code's daemon, shown in a floating kitty window; the host takes one in with its next
// message.

const KINDS = new Set(["panel", "window"]);
const BASE = `http://127.0.0.1:${PORT}`; // the address a chat reaches desk at, as SKILL.md's examples do

// The agent's settings, as the Agent tab had them: no permission prompts, and a few commands no chat should run. Its
// model and effort are the chat's pick (models.ts), and a new chat's those of Settings > Preferences.
const OPTIONS = { permissionMode: "bypassPermissions", disallowedTools: ["Bash(sudo *)", "Bash(rm -rf /*)", "Bash(rm -rf ~*)"] } as const;

const runsOn = (chat: Chat) => {
  const { model, effort } = models.shown(chat.session, true);
  return { model, effort: effort as Effort };
};

// How the host starts the chat's session again: where it runs, with its prompt and settings.
export async function hostOptions(chat: Chat, cwd = runsIn(chat)): Promise<hosted.StartOptions> {
  return { id: chat.session, resume: true, cwd, ...OPTIONS, ...runsOn(chat), disallowedTools: [...OPTIONS.disallowedTools], additionalDirectories: adds(cwd),
    append: await agentPrompt(chat, BASE) };
}

// Start a chat's session in the host, idle until the user writes in its panel. Given an issue in Triage and a first
// message, as for a Slack message the user tagged (slack.ts), the chat starts bound to the issue and works on the
// message at once.
export async function newChat(base: string, start?: { issue: Issue; message: string }): Promise<Chat> {
  // strftime's %b in the C locale: Sep, never Sept.
  const d = new Date(), month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const chat: Chat = { id: `chat-${randomBytes(4).toString("hex")}`, kind: "panel", title: start?.issue.title ?? "New chat", created: now(), session: "", messages: [],
    ...(start && { issue: start.issue.slug, folder: DATA_DIR }) }; // where bind() leaves a chat whose issue has no folder
  const name = `desk chat ${d.getDate()} ${month} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const s = settings.load(), runs = { model: s.chat_model, effort: s.chat_effort };
  const row = await hosted.start({ cwd: DATA_DIR, title: name, ...OPTIONS, ...runs, disallowedTools: [...OPTIONS.disallowedTools], append: await agentPrompt(chat, base),
    ...(start ? { message: start.message } : {}) });
  chat.session = row.id;
  models.keep(row.id, runs); // the chat keeps what it started on when Preferences change later
  save(chat);
  return chat;
}

// The user's words and the agent's, in order, from a chat's transcript.
export function* said(chat: Chat): Generator<[string, string]> {
  const path = transcripts.pathOf(chat.session);
  if (!path) return;
  for (const item of transcripts.read(path, 0)[0].flatMap(transcripts.itemsOf)) {
    if (item.t === "you" && item.text) yield ["user", item.text];
    else if (item.t === "text" && item.text) yield ["assistant", item.text.trim()];
  }
}

// A chat nobody has written in yet: no issue, and no transcript, which its session writes only from its first message.
export const empty = (chat: Chat) => !chat.issue && !transcripts.pathOf(chat.session);

// When a chat last moved: its transcript's last write, or its start.
export function activity(chat: Chat): string {
  const file = transcripts.pathOf(chat.session);
  if (!file) return chat.created;
  const d = statSync(file).mtime, pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function chats(): Chat[] {
  if (!existsSync(CHATS_DIR)) return [];
  return readdirSync(CHATS_DIR).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(CHATS_DIR, n), "utf8")));
}

// The agent chat whose session this is, if any.
export function agentChatOf(session: string | null | undefined): Chat | null {
  return session ? chats().find((c) => KINDS.has(c.kind ?? "") && c.session === session) ?? null : null;
}

// The folder the chat's session runs in: DESK_DATA, where every chat starts, until desk moves it.
export const runsIn = (chat: Chat) => chat.cwd || DATA_DIR;

// The folder a chat's session runs in, when the session is a chat's.
export async function sessionRunsIn(session: string | null | undefined): Promise<string | null> {
  const chat = session ? chats().find((c) => c.session === session) : undefined;
  return chat ? runsIn(chat) : null;
}

// The agent chats, the one that moved last first.
export function agentChats(): Chat[] {
  return chats().filter((c) => KINDS.has(c.kind ?? "")).sort((a, b) => (activity(a) < activity(b) ? 1 : activity(a) > activity(b) ? -1 : 0));
}

// --- moving a chat -------------------------------------------------------------------------------------------------
// A chat's session loads the folder it runs in, and only that one, so once it binds to an issue in another folder desk
// moves it there, between two turns (chats.py, in git history, said what was checked, 15 Oct).

const MOVING = new Set<string>(); // the chats a move waits on, so a second bind does not start a second move
const MOVE_WAIT = 4 * 3600; // seconds a move waits for the chat's turn to end

function same(a: string, b: string): boolean {
  const real = (p: string) => { const full = resolve(p.startsWith("~") ? join(HOME, p.slice(1)) : p); try { return realpathSync(full); } catch { return full; } };
  return real(a) === real(b);
}

// Desk's data folder, which holds the issues' files, for a chat that runs elsewhere.
const adds = (cwd: string) => (same(DATA_DIR, cwd) || !existsSync(DATA_DIR) ? [] : [DATA_DIR]);

async function move(id: string, base: string) {
  try {
    await carryOver(id, base);
  } catch (error) {
    console.error(`desk: could not move ${id}: ${error}`); // nothing else would see a failure here
  } finally {
    MOVING.delete(id);
  }
}

// End the chat's process once its turn is over, and start it again in the issue's folder, telling it to carry on.
// When the folder will not take it, start it where it was, telling it why. Its panel follows by itself: the host
// holds the same session id again.
async function carryOver(id: string, base: string) {
  const began = performance.now() / 1000;
  let row: agents.Row;
  while ((row = await agents.liveRow(load(id).session, true)).status === "busy" || row.status === "waiting") {
    const waited = performance.now() / 1000 - began;
    if (waited > MOVE_WAIT) return;
    await new Promise((r) => setTimeout(r, waited < 60 ? 200 : 2000)); // the turn usually ends right after the bind
  }
  let chat = load(id);
  if ((row.kind === "interactive" && row.pid) || same(chat.folder!, runsIn(chat))) return;
  if (!Object.keys(row).length) { // nothing runs, so the next message starts it in the folder
    chat.cwd = chat.folder;
    save(chat);
    return;
  }
  if (row.kind === "host") {
    await hosted.close(chat.session).catch(() => {});
    await hosted.released(chat.session);
  } else {
    // From before the panel: drop the daemon's record of it, which would otherwise wake it in its old folder.
    await run(["claude", "rm", row.id!], { timeout: 30 });
    if (row.pid) await agents.exited(row.pid);
  }
  const i = await store.load(chat.issue!);
  const words = { folder: chat.folder!, title: i.title, base, slug: i.slug };
  let moved = false;
  try {
    await hosted.start({ ...(await hostOptions(chat, chat.folder!)), message: fill(MOVED, words) });
    moved = true;
  } catch (error) {
    await hosted.start({ ...(await hostOptions(chat)), message: fill(NOT_MOVED, { why: (error as Error).message, ...words }) });
  }
  chat = load(id);
  if (moved) {
    chat.cwd = chat.folder;
    save(chat);
  }
}
