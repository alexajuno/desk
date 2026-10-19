// desk's agent (ported from desk/chats.py): a Claude Code session with desk's own skills, which files issues and works them itself,
// in desk's session panel. It starts in DESK_DATA and reaches desk through curl to its API. Work on an issue
// is done in the chat: the chat binds itself to the issue (POST /api/issues/<slug>/work), which makes the chat's session
// the issue's session, and desk then moves the chat into the issue's folder, so that Claude Code loads that folder's
// CLAUDE.md, rules, skills, agents and settings.
//
// A chat may instead be one of the user's own agents' (roster.ts): it runs as that agent, from the home folder, with no
// desk prompt, and files no issue. Or it may be bare, a Chat in the composer's chip: Claude Code as `claude` runs from
// the home folder, with no agent and no desk prompt, and it files no issue either.
//
// A chat is a JSON file in DESK_DATA/chats/.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import * as agents from "./agents.ts";
import { CHATS_DIR, DATA_DIR, HOME, PORT, REPO } from "./config.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as models from "./models.ts";
import { run, sleep } from "./proc.ts";
import { fill, MOVED, NOT_MOVED, PLAN_RULES, PROMPT, PROTOCOLS, WINDOW_RULES, WORK } from "./prompts.ts";
import type { Agent } from "./roster.ts";
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
  agent?: string; // the agent the chat is with, by name; none for desk's own
  bare?: boolean; // a Chat: no agent and no desk prompt
  named?: string; // the title the user gave it, or its automation's, over Claude Code's
  from?: string; // the script whose message started it (push)
  automation?: string; // the automation whose run it is, by slug (automations.ts)
  seen?: number; // when the user last looked at it, in seconds, until 19 Oct: seen.ts keeps it since
  [key: string]: unknown;
}

export class NoChat extends Error {}

const CHAT_ID = /^[a-z0-9-]{1,80}$/;

// --- the chats, kept ---------------------------------------------------------------------------------------------
// desk alone writes a chat's file (save), and never removes one, so the files are read once, at the first ask, and
// kept: a new chat is appended, a saved one replaced. "chat should be append and it's just there. no need to read all
// files at once for that" (the user, 18 Oct): every sidebar rebuild used to read all of them five times. When each
// last moved is kept beside it: its transcript's last write at that first read, then each turn starting or ending.

let kept: Map<string, Chat> | null = null; // by id
const bySession = new Map<string, Chat>();
const lastMoved = new Map<string, number>(); // by id, in ms

function keep(chats: Map<string, Chat>, chat: Chat) {
  const was = chats.get(chat.id);
  if (was && was.session !== chat.session) bySession.delete(was.session);
  chats.set(chat.id, chat);
  if (chat.session) bySession.set(chat.session, chat);
}

function all(): Map<string, Chat> {
  if (kept) return kept;
  const read = new Map<string, Chat>();
  for (const name of existsSync(CHATS_DIR) ? readdirSync(CHATS_DIR) : []) {
    if (!name.endsWith(".json")) continue;
    const chat: Chat = JSON.parse(readFileSync(join(CHATS_DIR, name), "utf8"));
    keep(read, chat);
    const file = transcripts.pathOf(chat.session);
    lastMoved.set(chat.id, file ? statSync(file).mtimeMs : Date.parse(chat.created));
  }
  return (kept = read);
}

const ofSession = (session: string) => (all(), bySession.get(session));

// A copy to change and save(): the kept one changes only by save.
export function load(id: string): Chat {
  const chat = CHAT_ID.test(id) ? all().get(id) : undefined;
  if (!chat) throw new NoChat("No such chat");
  return structuredClone(chat);
}

// A turn of this session started or ended now (sync.ts sees it in ~/.claude/sessions).
export function moved(session: string) {
  const chat = ofSession(session);
  if (chat) lastMoved.set(chat.id, Date.now());
}

// When the chat last moved, in ms.
export const movedAt = (chat: Chat) => lastMoved.get(chat.id) ?? 0;

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
  const chats = all(), fresh = !chats.has(chat.id);
  mkdirSync(CHATS_DIR, { recursive: true });
  chat.updated = now();
  writeFileSync(join(CHATS_DIR, `${chat.id}.json`), pyJson(chat), "utf8");
  keep(chats, structuredClone(chat));
  if (fresh) lastMoved.set(chat.id, Date.now());
}

export const exists = (id: string) => CHAT_ID.test(id) && all().has(id);

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
  const work = fill(WORK, { dir: folder, file: join(folder, "issue.md"), plan: join(folder, "plan.md"), base, slug: slug || "<slug>" });
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
  if (chat.agent) return { id: chat.session, resume: true, cwd, agent: chat.agent, settings: AGENT_SETTINGS, ...OPTIONS, ...runsOn(chat), disallowedTools: [...OPTIONS.disallowedTools] };
  if (chat.bare) return { id: chat.session, resume: true, cwd, ...OPTIONS, ...runsOn(chat), disallowedTools: [...OPTIONS.disallowedTools] };
  return { id: chat.session, resume: true, cwd, ...OPTIONS, ...runsOn(chat), disallowedTools: [...OPTIONS.disallowedTools], additionalDirectories: adds(cwd),
    append: await agentPrompt(chat, BASE) };
}

// Start a chat's session in the host, idle until the user writes in its panel. Given an issue in Triage and a first
// message, as for a Slack message the user tagged (slack.ts), the chat starts bound to the issue and works on the
// message at once.
export async function newChat(base: string, start?: { issue: Issue; message: string }): Promise<Chat> {
  const chat: Chat = { id: newId(), kind: "panel", title: start?.issue.title ?? "New chat", created: now(), session: "", messages: [],
    ...(start && { issue: start.issue.slug, folder: DATA_DIR }) }; // where bind() leaves a chat whose issue has no folder
  const s = settings.load(), runs = { model: s.chat_model, effort: s.chat_effort };
  const row = await hosted.start({ cwd: DATA_DIR, title: `desk chat ${stamp()}`, ...OPTIONS, ...runs, disallowedTools: [...OPTIONS.disallowedTools], append: await agentPrompt(chat, base),
    ...(start ? { message: start.message } : {}) });
  chat.session = row.id;
  models.keep(row.id, runs); // the chat keeps what it started on when Preferences change later
  save(chat);
  return chat;
}

const newId = () => `chat-${randomBytes(4).toString("hex")}`;

// "17 Oct 19:24", for the name desk gives the session it starts. strftime's %b in the C locale: Sep, never Sept.
function stamp(): string {
  const d = new Date(), month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${d.getDate()} ${month} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// --- chats with the user's agents ------------------------------------------------------------------------------------
// The user's words: "i would like a way to start psy from here, to talk about situation. psy = any agent" (18 Oct). A
// chat with an agent runs as `psy` runs it in a terminal: `claude --agent <name>` from the home folder, the output style
// at the default, the effort the agent names. Either side starts it: the user with @name, or a script (push).

const AGENT_SETTINGS = { outputStyle: "default" }; // as `psy` and bin/coach start theirs

// The agent's own model and effort, else a desk chat's (Settings > Preferences).
function agentRuns(agent: Agent): models.Pick {
  const s = settings.load();
  return { model: agent.model ?? s.chat_model, effort: agent.effort ?? s.chat_effort };
}

// A new chat with the agent, or a bare one with none, its session started in the host, with a first message when given
// one.
export async function agentChat(agent: Agent | null, message?: hosted.Content, more: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = { id: newId(), kind: "panel", ...(agent ? { agent: agent.name, title: agent.name } : { bare: true, title: "Chat" }), created: now(),
    session: randomUUID(), messages: [], cwd: HOME, ...more };
  const s = settings.load();
  models.keep(chat.session, agent ? agentRuns(agent) : { model: s.chat_model, effort: s.chat_effort });
  await hosted.start({ ...(await hostOptions(chat)), title: `${agent?.name ?? "chat"} ${stamp()}`, ...(message ? { message } : {}) });
  save(chat);
  return chat;
}

// @name as the first words of a new chat: the chat, which nobody has written in yet, becomes the agent's.
export const becomeAgent = (chat: Chat, agent: Agent, message: hosted.Content) =>
  restartAs(chat, { agent: agent.name, title: agent.name, cwd: HOME }, agentRuns(agent), `${agent.name} ${stamp()}`, message);

// The composer's chip set to Chat when the first message is sent: the chat becomes bare, on the model and effort
// picked for it so far.
export const becomeBare = (chat: Chat, message: hosted.Content) => restartAs(chat, { bare: true, cwd: HOME }, runsOn(chat), `chat ${stamp()}`, message);

// A new chat's session starts again as what it became, with the message as typed, so the panel finds it in the
// transcript. When that session will not start, the chat stays desk's.
async function restartAs(chat: Chat, became: Partial<Chat>, runs: models.Pick, title: string, message: hosted.Content) {
  if (await hosted.holds(chat.session)) {
    await hosted.close(chat.session).catch(() => {});
    await hosted.released(chat.session);
  }
  const was = { ...chat };
  Object.assign(chat, became);
  try {
    await hosted.start({ ...(await hostOptions(chat)), ...runs, title, message });
  } catch (error) {
    Object.assign(chat, was);
    throw error;
  }
  models.keep(chat.session, runs);
  save(chat);
}

// A script's message for the user (POST /api/agents/<name>/say): a new chat with the agent, whose first turn passes it
// on. The panel shows the message only as who sent it (transcript.ts, PUSH); the agent's reply is what the user reads.
export function push(agent: Agent, text: string, from: string): Promise<Chat> {
  const who = from.replace(/["<>\n]/g, " ").trim().slice(0, 60) || "a script";
  const message = `<desk-push from="${who}">\n${text.trim()}\n</desk-push>\n\n${who} sent this for the user. desk opens a chat with you for it: your ` +
    "reply is the first thing the user reads, and they may answer you there. Tell them what matters in it, briefly.";
  return agentChat(agent, message, { from: who });
}

// An automation's run (automations.ts): a chat with its agent, or a bare one, named after it, which starts on the
// message and waits in the Inbox with its reply.
export const automationRun = (agent: Agent | null, title: string, slug: string, message: string) =>
  agentChat(agent, message, { named: title, automation: slug });

// The user's own title for the chat, or none to give it back Claude Code's. "Rename by hand" (the user, 18 Oct).
export function rename(session: string, title: string) {
  const chat = agentChatOf(session);
  if (!chat) throw new NoChat("No such chat");
  if (title) chat.named = title;
  else delete chat.named;
  save(chat);
}

// The title the user gave the session's chat, if any.
export const namedOf = (session: string) => ofSession(session)?.named ?? "";

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
export const empty = (chat: Chat) => !chat.issue && !chat.agent && !chat.bare && !transcripts.pathOf(chat.session);

// Every chat as kept, to read, not to change: load() gives one to change.
const chats = (): Chat[] => [...all().values()];

// The agent chat whose session this is, if any, as a copy to change.
export function agentChatOf(session: string | null | undefined): Chat | null {
  const chat = session ? ofSession(session) : undefined;
  return chat && KINDS.has(chat.kind ?? "") ? structuredClone(chat) : null;
}

// The folder the chat's session runs in: DESK_DATA, where every chat starts, until desk moves it.
export const runsIn = (chat: Chat) => chat.cwd || DATA_DIR;

// The folder a chat's session runs in, when the session is a chat's.
export async function sessionRunsIn(session: string | null | undefined): Promise<string | null> {
  const chat = session ? ofSession(session) : undefined;
  return chat ? runsIn(chat) : null;
}

// The agent chats, the one that moved last first, as kept: to read, not to change.
export function agentChats(): Chat[] {
  return chats().filter((c) => KINDS.has(c.kind ?? "")).sort((a, b) => (lastMoved.get(b.id) ?? 0) - (lastMoved.get(a.id) ?? 0));
}

// The chat filing an issue of this title now, for a call that does not send the chat's id: one with no issue yet whose
// transcript holds the curl that files it. Claude Code writes the tool call to the transcript some 30 ms after it starts
// the command, and desk answers a curl sooner, so it looks again for a few seconds (18 Oct: looking once, it bound no
// chat, and the Inbox could not open one).
export async function filing(title: string): Promise<Chat | null> {
  for (let waited = 0; waited < 3000; waited += 100) {
    const chat = filingNow(title);
    if (chat) return chat;
    await sleep(100);
  }
  return null;
}

function filingNow(title: string): Chat | null {
  const typed = JSON.stringify(title).slice(1, -1);
  for (const chat of chats()) {
    if (!KINDS.has(chat.kind ?? "") || chat.issue || chat.agent) continue;
    const path = transcripts.pathOf(chat.session);
    if (!path || Date.now() - statSync(path).mtimeMs > 60_000) continue;
    const [recent] = transcripts.read(path, Math.max(0, statSync(path).size - 256 * 1024)); // its last steps
    const calls = recent.flatMap((e) => (e.type === "assistant" && Array.isArray(e.message?.content) ? e.message.content : []));
    if (calls.some((b) => b.type === "tool_use" && String(b.input?.command ?? "").includes("/api/issues") && String(b.input.command).includes(typed)))
      return structuredClone(chat); // which the caller binds
  }
  return null;
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
