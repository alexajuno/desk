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
// A chat is a row of the chats table, which the app holds (db.ts): "you should find whatever represent state, should
// be in db" (the user, 19 Oct). Until then it was a JSON file in DESK_DATA/chats/.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import * as agents from "./agents.ts";
import { CHATS_DIR, DATA_DIR, HOME, PORT, REPO } from "./config.ts";
import * as db from "./db.ts";
import type { Db } from "./db.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as models from "./models.ts";
import { run, sleep } from "./proc.ts";
import { fill, HANDED, HANDED_ON, HANDED_TODO, HANDED_TOLD, HANDED_WHERE, MOVED, NOT_MOVED, ON_ISSUE, PLAN_RULES, PROMPT, PROTOCOLS, WINDOW_RULES, WORK } from "./prompts.ts";
import type { Agent } from "./roster.ts";
import * as settings from "./settings.ts";
import type { Effort } from "./settings.ts";
import * as transcripts from "./transcript.ts";
import * as turns from "./turns.ts";

const SKILL = join(REPO, "skill", "SKILL.md");
const SKILL_BASE = "http://127.0.0.1:8790"; // the address SKILL.md is written for; each chat swaps in its own

export interface Chat {
  id: string;
  kind?: string;
  title: string;
  created: string;
  updated?: string;
  session: string;
  issue?: string;
  folder?: string;
  cwd?: string;
  agent?: string; // the agent the chat is with, by name; none for desk's own
  bare?: boolean; // a Chat: no agent and no desk prompt
  auto?: boolean; // Auto in its composer: desk says next for the user as a turn ends (auto.ts)
  named?: string; // the title the user gave it, or its automation's, over Claude Code's
  from?: string; // the script whose message started it (push)
  automation?: string; // the automation whose run it is, by slug (automations.ts)
  threads?: string[]; // the Slack threads, DMs and mail threads it follows (follow): the one it started on, and any attached since
  seen?: number; // when the user last looked at it, in seconds, until 19 Oct: the inbox table keeps it since (inbox.ts)
  deleted?: string; // when the user deleted it (remove)
  [key: string]: unknown; // what else its file held, such as the messages of a chat from before the panel
}

export class NoChat extends Error {}

const CHAT_ID = /^[a-z0-9-]{1,80}$/;

// --- the chats, kept ---------------------------------------------------------------------------------------------
// desk alone writes a chat's row (save), and never removes one, so the rows are read once, at start, and kept: a new
// chat is appended, a saved one replaced. "chat should be append and it's just there. no need to read all files at once
// for that" (the user, 18 Oct): every sidebar rebuild used to read all of them five times. When each last moved is kept
// beside it: its transcript's last write at start, then each turn starting or ending.

let kept: Map<string, Chat> | null = null; // by id
const bySession = new Map<string, Chat>();
const lastMoved = new Map<string, number>(); // by id, in ms

function keep(chats: Map<string, Chat>, chat: Chat) {
  byIssue = null;
  const was = chats.get(chat.id);
  if (was && was.session !== chat.session) bySession.delete(was.session);
  chats.set(chat.id, chat);
  if (chat.session) bySession.set(chat.session, chat);
}

function all(): Map<string, Chat> {
  if (!kept) throw new Error("The chats are not read in yet.");
  return kept;
}

const ofSession = (session: string) => (all(), bySession.get(session));

// Each issue's chat, by slug: the newest agent chat on it, out of sight or not, since a chat that takes an issue over
// from one sitting idle is newer. An issue holds no session of its own since 29 Oct: its chat does, and says which
// issue it works ("many chats to one issue. so... read chat's issue is correct?", the user). Made again after a change.
let byIssue: Map<string, Chat> | null = null;

function chatsByIssue(): Map<string, Chat> {
  if (byIssue) return byIssue;
  const made = new Map<string, Chat>();
  for (const chat of all().values()) {
    if (!chat.issue || !KINDS.has(chat.kind ?? "")) continue;
    const had = made.get(chat.issue);
    if (!had || had.created < chat.created) made.set(chat.issue, chat);
  }
  return (byIssue = made);
}

// The session of the issue's chat, or null when it has none.
export const sessionOfIssue = (slug: string): string | null => chatsByIssue().get(slug)?.session ?? null;

// Every desk chat that works the issue, the newest and the ones before it.
export const allOfIssue = (slug: string): Chat[] => [...all().values()].filter((c) => c.issue === slug && KINDS.has(c.kind ?? ""));

// The issue the session's chat works, or null.
export const issueOfSession = (session: string | null | undefined): string | null => (session ? ofSession(session)?.issue ?? null : null);

// A copy to change and save(): the kept one changes only by save.
export function load(id: string): Chat {
  const chat = CHAT_ID.test(id) ? all().get(id) : undefined;
  if (!chat) throw new NoChat("No such chat");
  return structuredClone(chat);
}

// A turn of this session started or ended now, as the session host told desk (turns.ts).
export function moved(session: string) {
  const chat = ofSession(session);
  if (chat) lastMoved.set(chat.id, Date.now());
}

// When the chat last moved, in ms.
export const movedAt = (chat: Chat) => lastMoved.get(chat.id) ?? 0;

const now = () => store.now();

// --- the table -------------------------------------------------------------------------------------------------------

const COLUMNS = ["id", "kind", "title", "created", "updated", "session", "issue", "folder", "cwd", "agent", "bare", "auto", "named", "from", "automation", "threads", "seen", "deleted"];

const UPSERT = `insert into chats (${[...COLUMNS, "extra"].map((c) => `"${c}"`).join(", ")})
  values (${[...COLUMNS, "extra"].map((_, n) => `$${n + 1}`).join(", ")})
  on conflict (id) do update set ${[...COLUMNS.slice(1), "extra"].map((c) => `"${c}" = excluded."${c}"`).join(", ")}`;

async function put(tx: Db, chat: Chat) {
  const extra = Object.fromEntries(Object.entries(chat).filter(([k]) => !COLUMNS.includes(k)));
  const value = (c: string) => (c === "bare" || c === "auto" ? Boolean(chat[c]) : c === "threads" ? (chat.threads?.length ? chat.threads : null) : (chat[c] ?? null));
  await tx.query(UPSERT, [...COLUMNS.map(value), extra]);
}

// The chat a row holds, with the fields it leaves empty left out, as its file did.
function chatOf(row: Record<string, unknown>): Chat {
  const { extra, bare, auto, ...columns } = row;
  const chat = Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== null)) as Chat;
  return { ...(extra as object), ...chat, ...(bare ? { bare: true } : {}), ...(auto ? { auto: true } : {}) };
}

// Write the chat, and what more writes with it, as one write. The chat is kept before it commits, so the frame the apps
// are sent once it does holds it.
// An issue's new slug, which a new title gave it (issues.ts, follow): its chat follows, in the same write.
store.onRename(async (tx, from, to) => {
  const chats = all();
  for (const chat of [...chats.values()].filter((c) => c.issue === from)) {
    const copy = { ...structuredClone(chat), issue: to };
    await put(tx, copy);
    keep(chats, copy);
  }
});

export async function save(chat: Chat, more?: (tx: Db) => Promise<unknown>) {
  const chats = all(), fresh = !chats.has(chat.id);
  chat.updated = now();
  const copy = structuredClone(chat);
  await db.write(async (tx) => {
    await more?.(tx);
    await put(tx, copy);
    keep(chats, copy);
  });
  if (fresh) lastMoved.set(chat.id, Date.now());
}

// At start: the chats' files written since desk last looked are read in, then every row is kept. Every file, the first
// time; then any a desk from before the table wrote, as an older branch on Try did, which wins over the row, being
// newer.
export async function readIn() {
  await db.write(async (tx) => {
    const since = Number((await tx.query<{ value: string }>("select value from meta where name = 'chats read'")).rows[0]?.value ?? 0);
    let newest = since;
    for (const name of existsSync(CHATS_DIR) ? readdirSync(CHATS_DIR) : []) {
      const path = join(CHATS_DIR, name), at = statSync(path).mtimeMs;
      if (!name.endsWith(".json") || at <= since) continue;
      newest = Math.max(newest, at);
      let chat: Chat;
      try {
        chat = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        console.error(`desk: could not read in ${path}: ${error}`);
        continue;
      }
      // Checked first: a query that fails would end the whole read-in.
      if (CHAT_ID.test(chat.id) && [chat.title, chat.created, chat.session].every((v) => typeof v === "string")) await put(tx, chat);
      else console.error(`desk: ${path} is no chat`);
    }
    if (newest > since)
      await tx.query("insert into meta values ('chats read', $1) on conflict (name) do update set value = excluded.value", [String(newest)]);
    // A thread's chat from before 3 Nov kept its one thread in extra: it follows it, from its threads.
    await tx.query("update chats set threads = coalesce(threads, '{}') || array[extra->>'thread'], extra = extra - 'thread' where extra ? 'thread'");
  });
  const read = new Map<string, Chat>();
  for (const row of (await db.sql().query<Record<string, unknown>>("select * from chats")).rows) {
    const chat = chatOf(row);
    keep(read, chat);
    const file = transcripts.pathOf(chat.session);
    lastMoved.set(chat.id, file ? statSync(file).mtimeMs : Date.parse(chat.created));
  }
  kept = read;
}

export const exists = (id: string) => CHAT_ID.test(id) && all().has(id);

// Once: each session Plan, Start or /start began before 29 Oct, which no chat held, becomes a chat on its issue, in the
// folder it ran in, so that every issue finds its chat the same way, by the chat's issue. Of the issues one such session
// worked, the chat takes an open one, else the newest. Returns how many it made.
export async function adoptSessions(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from meta where name = 'sessions adopted'")).rows.length) return 0;
    const rows = (await tx.query<{ slug: string; title: string; state: string; created: string; folder: string | null; session: string }>(
      "select slug, title, state, created, folder, session from issues where coalesce(session, '') <> '' order by created")).rows;
    const bySession = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (ofSession(r.session)) continue;
      const had = bySession.get(r.session);
      if (!had || CLOSED.has(had.state) || !CLOSED.has(r.state)) bySession.set(r.session, r);
    }
    for (const [session, r] of bySession) {
      const folder = resolve(agents.workdir({ folder: r.folder } as Issue));
      const chat: Chat = { id: newId(), kind: "panel", title: r.title, created: r.created, updated: now(), session, issue: r.slug, folder,
        cwd: transcripts.cwdOf(session) ?? folder };
      await put(tx, chat);
      keep(all(), chat);
      const file = transcripts.pathOf(session);
      lastMoved.set(chat.id, file ? statSync(file).mtimeMs : Date.parse(r.created));
    }
    await tx.query("insert into meta values ('sessions adopted', now()::text)");
    return bySession.size;
  });
}

const CLOSED = new Set(["done", "dropped"]);

// Once, after adoptSessions: each open issue whose chat went on to another issue before 29 Oct gets a chat of its own,
// idle until you write in it, which knows the chat it takes over from (agentPrompt). "a chat keeps its one issue"
// (the user's pick, 29 Oct). Returns how many it made.
export async function adoptLeft(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from meta where name = 'left issues chatted'")).rows.length) return 0;
    const rows = (await tx.query<{ slug: string; title: string; state: string; folder: string | null; session: string }>(
      "select slug, title, state, folder, session from issues where coalesce(session, '') <> '' order by created")).rows;
    let made = 0;
    for (const r of rows) {
      if (CLOSED.has(r.state) || chatsByIssue().has(r.slug)) continue;
      const folder = r.folder ? resolve(agents.workdir({ folder: r.folder } as Issue)) : DATA_DIR, from = ofSession(r.session)?.id;
      const chat: Chat = { id: newId(), kind: "panel", title: r.title, created: now(), updated: now(), session: randomUUID(), issue: r.slug,
        folder, cwd: existsSync(folder) ? folder : DATA_DIR, ...(from ? { from } : {}) };
      await put(tx, chat);
      keep(all(), chat);
      lastMoved.set(chat.id, 0);
      made++;
    }
    await tx.query("insert into meta values ('left issues chatted', now()::text)");
    return made;
  });
}

// The chat as plain text, the user's words and the agent's replies in order, for a session's first prompt.
export function transcript(id: string): string {
  const names: Record<string, string> = { user: "The user", assistant: "desk's agent" };
  return [...said(load(id))].map(([who, text]) => `${names[who]}: ${text}`).join("\n\n");
}

// The chat becomes the issue's session: the issue, as the caller set it, and the chat are saved as one write. desk
// moves the chat into the issue's folder once its turn ends. An issue in Triage has no folder yet, so the chat stays
// where it runs.
// The issue's earlier session, which the chat takes over, lets the issue go too when it is a chat of its own. The chat
// working the issue holds its threads, so it takes those of the issue's chats before it.
export async function bind(chat: Chat, i: Issue, base: string, previous: string | null = null) {
  chat.issue = i.slug;
  delete chat.deleted; // a chat at work is in sight
  chat.folder = i.folder ? resolve(agents.workdir(i)) : runsIn(chat);
  const found = previous ? agentChatOf(previous) : null, old = found?.issue === i.slug ? found : null;
  if (old) {
    delete old.issue;
    old.updated = now();
  }
  const before = [...all().values()].filter((c) => c.id !== chat.id && c.issue === i.slug).flatMap((c) => c.threads ?? []);
  if (before.length) chat.threads = [...new Set([...(chat.threads ?? []), ...before])];
  await save(chat, async (tx) => {
    await store.saveIn(tx, i);
    if (old) {
      await put(tx, old);
      keep(all(), old);
    }
    await takeFrom(tx, chat);
  });
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
  const work = fill(WORK, { dir: folder, drafts: store.drafts(slug || "<slug>"), base, slug: slug || "<slug>" });
  const rules = Object.fromEntries(Object.entries(WINDOW_RULES).map(([k, v]) => [k, fill(v, { base })]));
  // A chat may run for days, and Claude Code gives it the date.
  const plan_rules = fill(PLAN_RULES, { base, drafts: store.drafts(slug || "<slug>"), slug: slug || "<slug>" }); // its steps' call
  let prompt = fill(PROMPT, { today: "the date your environment gives", day: "15 Oct", reference, chat: chat.id, plan_rules, work,
    protocols: PROTOCOLS, ...rules });
  if (slug) prompt += `\n\nThis chat works the issue /issue/${slug}, in ${chat.folder}.`;
  // The chat it took the issue on from, by a handoff or when that chat went on to other work: its conversation is there.
  const before = chat.from && exists(chat.from) ? all().get(chat.from)! : null, path = before && transcripts.pathOf(before.session);
  if (before && path) {
    const on = before.issue && (await store.exists(before.issue)) ? `the chat on “${(await store.load(before.issue)).title}”` : `the chat “${before.named || before.title}”`;
    prompt += ` It took the issue on from ${on}, whose whole conversation is in ${path}, for what the issue's document and your first message leave out.`;
  }
  else if (chat.cwd && !same(chat.cwd, DATA_DIR))
    prompt += `\n\nThe user started this chat in ${chat.cwd}, picked in its composer: when you accept its issue, that is its folder, unless the talk names another.`;
  return prompt;
}

// --- the chats ---------------------------------------------------------------------------------------------------
// A chat is a session in the host (host.ts), started in DESK_DATA with the agent's prompt. Chats from before the panel
// (kind "window") ran in Claude Code's daemon, shown in a floating kitty window; the host takes one in with its next
// message.

const KINDS = new Set(["panel", "window"]);
const BASE = `http://127.0.0.1:${PORT}`; // the address a chat reaches desk at, as SKILL.md's examples do

// The agent's settings: no permission prompts and no command barred, sudo included, as the user's own Claude Code runs
// (22 Oct: "remove all bans"). Its model and effort are the chat's pick (models.ts), and a new chat's those of
// Settings > Preferences.
const OPTIONS = { permissionMode: "bypassPermissions" } as const;

const runsOn = (chat: Chat) => {
  const { model, effort } = models.shown(chat.session, true);
  return { model, effort: effort as Effort };
};

// How the host starts the chat's session again: where it runs, with its prompt and settings.
export async function hostOptions(chat: Chat, cwd = runsIn(chat)): Promise<hosted.StartOptions> {
  if (chat.agent) return { id: chat.session, resume: true, cwd, agent: chat.agent, settings: AGENT_SETTINGS, ...OPTIONS, ...runsOn(chat) };
  if (chat.bare) return { id: chat.session, resume: true, cwd, ...OPTIONS, ...runsOn(chat) };
  return { id: chat.session, resume: true, cwd, ...OPTIONS, ...runsOn(chat), additionalDirectories: adds(cwd),
    append: await agentPrompt(chat, BASE) };
}

// Start a chat's session in the host, idle until the user writes in its panel. Given an issue in Triage and a first
// message, the chat starts bound to the issue and works on the
// message at once.
export async function newChat(base: string, start?: { issue: Issue; message: string }): Promise<Chat> {
  const chat: Chat = { id: newId(), kind: "panel", title: start?.issue.title ?? "New chat", created: now(), session: "",
    ...(start && { issue: start.issue.slug, folder: DATA_DIR }) }; // where bind() leaves a chat whose issue has no folder
  const s = settings.load(), runs = { model: s.chat_model, effort: s.chat_effort };
  const row = await hosted.start({ cwd: DATA_DIR, title: `desk chat ${stamp()}`, ...OPTIONS, ...runs, append: await agentPrompt(chat, base),
    ...(start ? { message: start.message } : {}) });
  chat.session = row.id;
  await models.keep(row.id, runs); // the chat keeps what it started on when Preferences change later
  await save(chat);
  return chat;
}

// An empty chat reused for a new one (sessions.ts, newSession) starts again on Settings > Preferences, as a new chat
// would: it kept what it started on, so one made before Preferences changed still showed the old pick (2 Nov: Opus at
// extra high, with Preferences on medium).
export async function renew(chat: Chat): Promise<Chat> {
  const s = settings.load(), pick = models.pickOf(chat.session);
  if (pick.model !== s.chat_model || pick.effort !== s.chat_effort)
    await models.change(chat.session, { model: s.chat_model, effort: s.chat_effort }).catch((error) => console.error("desk: renewing a chat's model", error));
  return chat;
}

const newId = () => `chat-${randomBytes(4).toString("hex")}`;

// A new chat on the issue, in its folder and bound to it from the start, which works on the message at once: Plan's,
// Start's, or another chat's handing work on. A chat works its one issue ("each guy handles one thing and communicate
// and tell the others to handle the rest", the user, 29 Oct).
export async function onIssue(i: Issue, message: string, more: Partial<Chat> = {}): Promise<Chat> {
  const folder = resolve(agents.workdir(i));
  const chat: Chat = { id: newId(), kind: "panel", title: i.title, created: now(), session: randomUUID(), issue: i.slug, folder, cwd: folder, ...more };
  const s = settings.load();
  await models.keep(chat.session, { model: s.chat_model, effort: s.chat_effort });
  await hosted.start({ ...(await hostOptions(chat)), title: `desk chat ${stamp()}`, message });
  await save(chat);
  return chat;
}

// The issue's chat, as a copy to change.
export function ofIssue(slug: string): Chat | null {
  const chat = chatsByIssue().get(slug);
  return chat ? structuredClone(chat) : null;
}

// Work handed on to the issue's chat, by the chat that found it (sender) or by whoever calls: the issue's chat takes it
// at once, or after its turn, and an issue with no chat gets one in its folder. The message says who sent it, and where
// that chat's whole conversation is, for what the note leaves out ("start a new chat with additional context if needed",
// the user, 29 Oct).
export async function handOn(i: Issue, note: string, sender: Chat | null): Promise<{ chat: Chat; started: boolean }> {
  const of = sender?.issue && (await store.exists(sender.issue)) ? (await store.load(sender.issue)).title : sender?.named || sender?.title;
  const who = (sender ? `the chat on “${of}”` : "another session").replace(/["<>\n]/g, " ");
  const path = sender ? transcripts.pathOf(sender.session) : null;
  const where = path ? fill(HANDED_WHERE, { path }) : "", Who = who[0].toUpperCase() + who.slice(1);
  const chat = ofIssue(i.slug);
  if (chat) {
    await agents.tell(chat.session, fill(HANDED_ON, { who, Who, note: note.trim(), where }));
    return { chat, started: false };
  }
  const p = { title: i.title, base: BASE, slug: i.slug, file: join(store.folder(i.slug), store.MAIN) };
  const start = fill(ON_ISSUE, { ...p, told: fill(HANDED_TOLD, { Who, where }), todo: HANDED_TODO });
  return { chat: await onIssue(i, fill(HANDED, { who, note: note.trim(), start }), sender ? { from: sender.id } : {}), started: true };
}

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
    session: randomUUID(), cwd: HOME, ...more };
  const s = settings.load();
  await models.keep(chat.session, agent ? agentRuns(agent) : { model: s.chat_model, effort: s.chat_effort });
  await hosted.start({ ...(await hostOptions(chat)), title: `${agent?.name ?? "chat"} ${stamp()}`, ...(message ? { message } : {}) });
  await save(chat);
  return chat;
}

// @name as the first words of a new chat: the chat, which nobody has written in yet, becomes the agent's. It runs from
// the home folder, or from the one picked in its composer (startIn).
export const becomeAgent = (chat: Chat, agent: Agent, message: hosted.Content) =>
  restartAs(chat, { agent: agent.name, title: agent.name, cwd: chat.cwd ?? HOME }, agentRuns(agent), `${agent.name} ${stamp()}`, message);

// The composer's chip set to Chat when the first message is sent: the chat becomes bare, on the model and effort
// picked for it so far, in the folder picked for it, or the home folder.
export const becomeBare = (chat: Chat, message: hosted.Content) =>
  restartAs(chat, { bare: true, cwd: chat.cwd ?? HOME }, runsOn(chat), `chat ${stamp()}`, message);

// The composer's folder chip, before the first message: the new chat's session starts again in the folder, idle, and
// the chat runs there whatever its first message makes it. The folder it starts in anyway, the home folder for a Chat
// and DESK_DATA for desk's agent, is no pick. "allowing me to select the dir in the beginning" (the user, 19 Oct).
export const startIn = (chat: Chat, folder: string, bare: boolean) =>
  restartAs(chat, { cwd: same(folder, bare ? HOME : DATA_DIR) ? undefined : folder }, runsOn(chat), `desk chat ${stamp()}`);

// A new chat's session starts again as what it became, with the message as typed, so the panel finds it in the
// transcript, or idle with none. When that session will not start, the chat stays as it was.
async function restartAs(chat: Chat, became: Partial<Chat>, runs: models.Pick, title: string, message?: hosted.Content) {
  if (await hosted.holds(chat.session)) {
    await hosted.close(chat.session).catch(() => {});
  }
  const was = { ...chat };
  Object.assign(chat, became);
  try {
    await hosted.start({ ...(await hostOptions(chat)), ...runs, title, ...(message ? { message } : {}) });
  } catch (error) {
    Object.assign(chat, was);
    throw error;
  }
  await models.keep(chat.session, runs);
  await save(chat);
}

// A script's message for the user (POST /api/agents/<name>/say): a new chat with the agent, whose first turn passes it
// on. The panel shows the message only as who sent it (transcript.ts, PUSH); the agent's reply is what the user reads.
export function push(agent: Agent, text: string, from: string): Promise<Chat> {
  const who = from.replace(/["<>\n]/g, " ").trim().slice(0, 60) || "a script";
  const message = `<desk-push from="${who}">\n${text.trim()}\n</desk-push>\n\n${who} sent this for the user. desk opens a chat with you for it: your ` +
    "reply is the first thing the user reads, and they may answer you there. Tell them what matters in it, briefly.";
  return agentChat(agent, message, { from: who });
}

// desk's agent chat on something that came in, started on its message, which files its issue in Triage from its first
// reply, its Context quoting the message: "it's just a normal chat. but i want instead, it starts with the context of
// that msg/email/event, then we'll create issue in desk" (the user, 3 Nov). Until then a thread's row and an automation
// with no agent started a bare Chat, which did real work with no issue to show for it.
async function cameIn(message: string, more: Partial<Chat>): Promise<Chat> {
  const chat: Chat = { id: newId(), kind: "panel", title: "New chat", created: now(), session: randomUUID(), ...more };
  const s = settings.load();
  await models.keep(chat.session, { model: s.chat_model, effort: s.chat_effort });
  await hosted.start({ ...(await hostOptions(chat)), title: `desk chat ${stamp()}`, message });
  await save(chat, (tx) => takeFrom(tx, chat));
  return chat;
}

// A chat on a Slack thread's, DM's or mail thread's Inbox row (threads.ts), named after the thread until it files its
// issue, which follows the thread from its start, so that it never hangs on the model remembering a call. One started
// before 3 Nov stays bare: a chat never changes kind.
export const onThread = (thread: string, title: string, message: string) => cameIn(message, { threads: [thread], named: title });

// --- the threads a chat follows --------------------------------------------------------------------------------------
// A chat follows the threads attached to it, with no end: "attach slack threads to a chat, and it'll follow that thread
// forever" (the user, 3 Nov), the attachment living on the chat, not on desk's copy of the messages, which goes after 14
// days (notices.ts). desk attaches the one a chat starts on (onThread); the chat's model attaches any other and lets one
// go, on the user's word (follow, letGo). A thread is one chat's, since its messages go somewhere: attaching it moves it.
// A deleted chat follows none, and a DM is followed only while the chat's issue is open, since a DM has no end and would
// bring every later message from that person here.

const DM = /^slack:[^:]+$/; // a DM's or a group DM's, the whole DM

// The threads the chat follows now, of those attached to it.
export function follows(chat: Chat, issues: Map<string, Issue>): string[] {
  if (chat.deleted) return [];
  const closed = Boolean(chat.issue) && CLOSED.has(issues.get(chat.issue!)?.state ?? "");
  return (chat.threads ?? []).filter((t) => !closed || !DM.test(t));
}

// The chat following the thread, or null: the newest the thread is attached to, as one from before 3 Nov may share it.
export function followerOf(thread: string, issues: Map<string, Issue>): Chat | null {
  const found = [...all().values()].filter((c) => c.threads?.includes(thread)).sort((a, b) => b.created.localeCompare(a.created))
    .find((c) => follows(c, issues).includes(thread));
  return found ? structuredClone(found) : null;
}

// Every thread attached to a chat not deleted, as Slack's door lets them in from a non-work channel too, and its
// read-back reads each (slack.ts).
export const attached = (): Set<string> => new Set([...all().values()].filter((c) => !c.deleted).flatMap((c) => c.threads ?? []));

// The same, reading the issue of the chat it is attached to.
export async function follower(thread: string): Promise<Chat | null> {
  const slugs = [...all().values()].filter((c) => c.issue && c.threads?.includes(thread)).map((c) => c.issue!);
  const issues = new Map<string, Issue>();
  for (const slug of new Set(slugs)) if (await store.exists(slug)) issues.set(slug, await store.load(slug));
  return followerOf(thread, issues);
}

// One thread, one chat: the chat's threads leave every other chat they were attached to, in the chat's write. Gives
// those chats.
async function takeFrom(tx: Db, chat: Chat): Promise<Chat[]> {
  const mine = new Set(chat.threads ?? []);
  const others = [...all().values()].filter((c) => c.id !== chat.id && c.threads?.some((t) => mine.has(t))).map((c) => structuredClone(c));
  for (const other of others) {
    other.threads = other.threads!.filter((t) => !mine.has(t));
    other.updated = now();
    await put(tx, other);
    keep(all(), other);
  }
  return others;
}

export class NotFollowed extends Error {}

// The thread attached to the chat, by its model's call (POST /api/chats/<id>/threads), from any chat it was attached to:
// gives the one that followed it, if any, for the model to tell the user.
export async function follow(id: string, thread: string): Promise<{ chat: Chat; from: Chat | null }> {
  const chat = load(id), had = await follower(thread);
  if (!chat.threads?.includes(thread)) chat.threads = [...(chat.threads ?? []), thread];
  await save(chat, (tx) => takeFrom(tx, chat));
  return { chat, from: had && had.id !== chat.id ? had : null };
}

// The thread let go of, by its model's call (DELETE /api/chats/<id>/threads), on the user's word: its next message goes
// through the firewall to a row of its own again.
export async function letGo(id: string, thread: string): Promise<Chat> {
  const chat = load(id);
  if (!chat.threads?.includes(thread)) throw new NotFollowed(`This chat does not follow ${thread}. It follows ${chat.threads?.join(", ") || "none"}.`);
  chat.threads = chat.threads.filter((t) => t !== thread);
  await save(chat);
  return chat;
}

// An automation's run (automations.ts), named after it, which starts on the message and waits in the Inbox with its
// reply: a chat with its agent, or, with none, desk's agent chat, which files its issue from the run.
export const automationRun = (agent: Agent | null, title: string, slug: string, message: string) =>
  agent ? agentChat(agent, message, { named: title, automation: slug }) : cameIn(message, { named: title, automation: slug });

// The user's own title for the chat, or none to give it back Claude Code's. "Rename by hand" (the user, 18 Oct).
export async function rename(session: string, title: string) {
  const chat = agentChatOf(session);
  if (!chat) throw new NoChat("No such chat");
  if (title) chat.named = title;
  else delete chat.named;
  await save(chat);
}

// Manual or Auto, the chip in the composer of desk's own chat: in Auto desk says next for the user as a turn ends on a
// step, and go on a plan (auto.ts). "sometimes i want the agent to just keep going completely automated" (the user,
// 29 Oct). A chat with an agent, or a bare one, works no issue, so it has no mode.
export async function setAuto(session: string, auto: boolean) {
  const chat = agentChatOf(session);
  if (!chat) throw new NoChat("No such chat");
  if (chat.agent || chat.bare) throw new NoChat("Only desk's own chat runs Manual or Auto: this one works no issue.");
  if (auto) chat.auto = true;
  else delete chat.auto;
  await save(chat);
}

// The title the user gave the session's chat, if any.
export const namedOf = (session: string) => ofSession(session)?.named ?? "";

// The states of an issue being worked: its chat shows though deleted, and Delete is refused, since the issue's questions
// and its review reach you through it. Drop the issue instead.
export const AT_WORK = new Set(["running", "waiting", "review", "landing"]);

export class AtWork extends Error {}

// Delete in a chat's menu, or its Undo: the chat goes out of sight, from the sidebar, the Inbox and the corner's history
// (pages.ts, sessions.ts), and comes back. Its row and its transcript stay. "some chats were started for testing and not
// meant to be displayed... maybe we don't need to clean up locally but just removing out of sight is better" (the user,
// 25 Oct). A chat's issue in Triage is the chat's own, so it is dropped with it, and Undo puts it back in Triage.
export async function remove(session: string, deleted: boolean) {
  const chat = agentChatOf(session);
  if (!chat) throw new NoChat("No such chat");
  const i = chat.issue && (await store.exists(chat.issue)) ? await store.load(chat.issue) : null;
  if (deleted && i && AT_WORK.has(i.state)) throw new AtWork(`Its issue is ${{ running: "in progress", review: "in review" }[i.state] ?? i.state}: drop the issue instead.`);
  let moves = false;
  if (deleted) {
    chat.deleted = now();
    if (i?.state === "triage") {
      i.state = "dropped";
      chat.dropped = i.slug;
      moves = true;
    }
  } else {
    delete chat.deleted;
    if (i && chat.dropped === i.slug && i.state === "dropped") {
      i.state = "triage";
      moves = true;
    }
    delete chat.dropped;
  }
  await save(chat, moves ? (tx) => store.saveIn(tx, i!) : undefined);
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
// One desk started on a thread or a run has its message, though its transcript may not be written yet.
export const empty = (chat: Chat) => !chat.issue && !chat.agent && !chat.bare && !chat.threads?.length && !chat.automation && !transcripts.pathOf(chat.session);

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
  if (!(await turns.settled(load(id).session, MOVE_WAIT))) return; // the turn usually ends right after the bind
  const row = await agents.liveRow(load(id).session, true);
  let chat = load(id);
  if ((row.kind === "interactive" && row.pid) || same(chat.folder!, runsIn(chat))) return;
  if (!Object.keys(row).length) { // nothing runs, so the next message starts it in the folder
    chat.cwd = chat.folder;
    await save(chat);
    return;
  }
  if (row.kind === "host") {
    await hosted.close(chat.session).catch(() => {});
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
    await save(chat);
  }
}
