// The one Claude Code session bound to an issue, from its plan to its landing (ported from desk/agents.py, which said
// how each step works and what was checked on Claude Code 2.1.285 and 2.1.300).
//
//   Plan       a session in the session host (host.ts), in the issue's folder: the repo's own rules say where the
//              session works. The session plans by the issue's protocol and keeps the plan in the issue's Plan section.
//   "go"       said in its panel: the same session carries out the plan, then writes its review card in the Result, or
//              on a design issue reports its last step, with no card.
//   Approve    the same session lands the work by the repo's rules: desk sends it the message, which waits its turn
//              when the session is working.
//
// A session from before the host, still in Claude Code's background daemon, moves into the host with its next message.
import { existsSync, readFileSync, renameSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME, PORT } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as hosted from "./hosted.ts";
import { run, sleep, which } from "./proc.ts";
import { BRIEF_FIRST, BRIEF_STEPS, DESIGN_GO_PROMPT, fill, GO_FIRST, GO_PROMPT, LAND_PROMPT, ON_ISSUE, PLAN_FIRST, PLAN_OF, STEPS_FAILED, TOLD } from "./prompts.ts";

export async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const r = await run(["git", ...args], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null; // no folder, or no git
  }
}

// Hyprland's start hook imports these into the user manager at login; desk.service starts at boot, before that, and
// the signature changes with each Hyprland start, so desk asks the manager each time it spawns something for the session.
const SESSION_VARS = ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY"];

export async function sessionEnv(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const out = (await run(["systemctl", "--user", "show-environment"], { timeout: 10 })).stdout;
  const nowVars: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) nowVars[line.slice(0, at)] = line.slice(at + 1);
  }
  const merged = { ...env };
  for (const name of SESSION_VARS) if (name in nowVars) merged[name] = nowVars[name];
  return merged;
}

export const workdir = (i: Issue) => (i.folder ? (i.folder.startsWith("~") ? join(HOME, i.folder.slice(1)) : i.folder) : HOME);

export interface Row {
  id?: string;
  sessionId?: string;
  pid?: number;
  status?: string;
  state?: string;
  kind?: string;
  cwd?: string;
  name?: string;
  [key: string]: unknown;
}

let seen: [number, Map<string, Row>] = [0, new Map()];
let listed: Row[] = []; // what `claude agents` last answered

// Every session Claude Code knows, keyed by short id and by full session id. A page asks several times, so an answer
// under a second old is reused (`claude agents` takes about 0.15 s); fresh asks again, as right after starting one.
// When `claude agents` fails, its last answer stands: read as no session at all, every working one would land in the
// Inbox as your turn.
export async function live(fresh = false): Promise<Map<string, Row>> {
  if (!fresh && performance.now() / 1000 - seen[0] < 1) return seen[1];
  try {
    const r = await run(["claude", "agents", "--json", "--all"], { timeout: 15 });
    listed = JSON.parse(r.stdout || "[]");
  } catch {
    // keep the last answer
  }
  const rows = listed;
  const byKey = new Map<string, Row>();
  for (const row of rows) for (const key of [row.id, row.sessionId]) if (key) byKey.set(key, row);
  // The host's sessions list as interactive, the way Claude Code lists any process it was not started in the
  // background as: say whose they are, and whether one waits on the user, which only the host knows.
  for (const h of await hosted.sessions(fresh)) {
    const listed = byKey.get(h.id);
    const row: Row = { ...listed, sessionId: h.id, kind: "host", cwd: listed?.cwd ?? h.cwd, name: listed?.name ?? h.title,
      pid: listed?.pid ?? -1, status: h.asks ? "waiting" : h.working ? "busy" : "idle", ...(h.asks ? { state: "blocked" } : {}) };
    delete row.id; // no short id: `claude stop` and `claude attach` are for the daemon's sessions
    byKey.set(h.id, row);
  }
  seen = [performance.now() / 1000, byKey];
  return byKey;
}

export const liveRow = async (session: string | null | undefined, fresh = false): Promise<Row> =>
  (session ? (await live(fresh)).get(session) : undefined) ?? {};

// The session's row as Claude Code last listed it, at once, for what a page only shows: an issue's "open in a terminal",
// a chat's folder. Waiting for a new listing held each issue page and each chat's first words up by 0.15 s (25 Oct), so a
// listing over a second old is asked for again behind, and the next look has it; only before the first one is it waited
// for.
let relisting: Promise<unknown> | null = null;
export async function shownRow(session: string | null | undefined): Promise<Row> {
  if (!seen[0]) return liveRow(session);
  if (performance.now() / 1000 - seen[0] >= 1) relisting ??= live().catch(() => {}).finally(() => { relisting = null; });
  return (session ? seen[1].get(session) : undefined) ?? {};
}

// Where the session stands, from its row in `claude agents --json`: working while a turn runs (status busy), idle while
// its process lives between turns, stopped with no process, whatever `state` says; none when it does not list.
export function status(row: Row): string {
  if (!row || !Object.keys(row).length) return "none";
  if (row.status === "busy") return "working";
  return row.pid ? "idle" : "stopped";
}

// What a session's prompt names: the issue, its folder, its drafts, and the address it tells desk its turn's end at.
const paths = (i: Issue, folder: string) => ({ title: i.title, file: join(folder, "issue.md"), dir: folder, drafts: store.drafts(i.slug),
  slug: i.slug, base: `http://127.0.0.1:${PORT}` });

// Claude Code refused to start a session because nobody accepted its trust prompt in the folder. The host runs
// Claude Code headless, which asks no trust, so only a page's Trust folder press still meets it.
export class TrustError extends Error {}

const CLAUDE_JSON = join(HOME, ".claude.json");

// Mark the folder trusted in Claude Code's own state, as accepting its trust prompt does:
// projects[<path>].hasTrustDialogAccepted. Running sessions rewrite that file too, so it is read and replaced in one go,
// then read back to check it stuck.
export function trust(folder: string) {
  const path = resolve(folder.startsWith("~") ? join(HOME, folder.slice(1)) : folder);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${path} is not a folder.`);
  const state = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
  state.projects ??= {};
  state.projects[path] ??= {};
  state.projects[path].hasTrustDialogAccepted = true;
  const temp = join(HOME, `.claude.json.desk-${process.pid}`);
  writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
  chmodSync(temp, statSync(CLAUDE_JSON).mode & 0o777);
  renameSync(temp, CLAUDE_JSON);
  if (!JSON.parse(readFileSync(CLAUDE_JSON, "utf8")).projects?.[path]?.hasTrustDialogAccepted)
    throw new Error("Claude Code rewrote its settings at the same moment and dropped the change. Press Trust folder again.");
}

// Start the issue's chat: a desk chat on it, in its folder, which works on the message at once (chats.ts, onIssue); its
// session id. Plan and Start started a session of their own until 29 Oct, which no chat held and only the issue pointed
// at.
async function newSession(i: Issue, message: string): Promise<string> {
  const chats = await import("./chats.ts");
  return (await chats.onIssue(i, message)).session;
}

// The chat's first message, by the issue's protocol: a sketch planned with the user, or a brief, after which it waits
// for "go" or goes on at once. chat is the agent chat it came from, if any.
export function planPrompt(i: Issue, folder: string, chat = ""): string {
  const p = paths(i, folder), runs = store.runs(i), told = chat ? fill(TOLD, { chat }) : "";
  if (runs === "design") return fill(ON_ISSUE, { ...p, told, todo: PLAN_FIRST });
  const [how, then] = BRIEF_STEPS[runs];
  return fill(ON_ISSUE, { ...p, told, todo: fill(BRIEF_FIRST, { protocol: runs, how, then }) });
}

// Plan, or Start: the issue's chat plans it by its protocol; its session id.
export const start = (i: Issue, folder: string) => newSession(i, planPrompt(i, folder));
// Go, by the issue's protocol: a design issue is carried out one step at a time with the user.
const goPrompt = (i: Issue, folder: string) => fill(store.runs(i) === "design" ? DESIGN_GO_PROMPT : GO_PROMPT, paths(i, folder));
// Start the issue's chat straight on its written plan; its session id.
export const runPlan = (i: Issue, folder: string) => {
  const p = paths(i, folder), todo = `${GO_FIRST[store.runs(i) === "design" ? "design" : "other"]} ${fill(PLAN_OF, p)}`;
  return newSession(i, fill(ON_ISSUE, { ...p, told: "", todo }));
};
// Start the issue's chat to plan from the agent chat, then wait, or go on at once for a quick issue.
export const planFromChat = (i: Issue, folder: string, chat: string) => newSession(i, planPrompt(i, folder, chat));
// The session of the issue's chat, which takes the issue's messages: an issue holds none of its own since 29 Oct.
async function chatOf(i: Issue): Promise<string> {
  const session = (await import("./chats.ts")).sessionOfIssue(i.slug);
  if (!session) throw new Error(`${i.title} has no chat to tell.`);
  return session;
}

// The desk agent starts an issue that already has a chat: the same chat carries out the plan.
export const go = async (i: Issue, folder: string) => tell(await chatOf(i), goPrompt(i, folder));
// Approve: the issue's own chat lands its work by the repo's rules.
export const land = async (i: Issue, folder: string) => tell(await chatOf(i), fill(LAND_PROMPT, paths(i, folder)));
// Approve ran the steps the chat gave, and one failed: the chat lands the work itself, from there.
export const landFailed = async (i: Issue, folder: string, ran: string) => tell(await chatOf(i), fill(STEPS_FAILED, { ...paths(i, folder), ran }));
// Give the issue's chat one message, as the user would.
export const say = async (i: Issue, message: string) => tell(await chatOf(i), message);

// Give a session its next message, as the user would in its panel. The host holds it, or takes it in: from the folder
// it runs in, and from Claude Code's daemon when it ran in the background before. A message to a session at work waits
// its turn, as Enter does in its terminal, or with now, goes in at once, as Ctrl+Enter does.
export async function tell(session: string, content: hosted.Content, uuid?: string, now = false) {
  if (await hosted.holds(session)) {
    try {
      await hosted.send(session, content, uuid, now);
      return;
    } catch (error) {
      // Closed, as we asked, or moving to the newest host (hosted.ts, send): start it again.
      if (!(error instanceof hosted.HostError && error.status === 404)) throw error;
    }
  }
  const row = await liveRow(session, true);
  if (row.kind === "interactive" && row.pid) throw new Error("This session is open in a terminal. Close it there, then try again.");
  if (row.status === "busy") throw new Busy("This session is still working in the background, where it ran before desk's panel. Wait until it is done, then try again.");
  if (row.pid && row.id) {
    await run(["claude", "stop", row.id], { timeout: 30 });
    // `claude stop` returns about half a second before the process exits; a resume in that gap would start a copy.
    await exited(row.pid);
  }
  await hosted.start({ ...(await resumeOptions(session)), message: content });
}

// The session works in Claude Code's daemon, which takes no message mid-turn.
export class Busy extends Error {}

// How the host brings a session back: in the folder it runs in, and a desk agent chat with its own prompt and flags.
export async function resumeOptions(session: string): Promise<hosted.StartOptions> {
  const chats = await import("./chats.ts");
  const chat = chats.agentChatOf(session);
  if (chat) return chats.hostOptions(chat);
  const picked = (await import("./models.ts")).pickOf(session); // the model and effort picked in its panel, if any
  const { cwdOf } = await import("./transcript.ts");
  const cwd = cwdOf(session);
  if (!cwd || !existsSync(cwd)) throw new Error(`Its folder${cwd ? `, ${cwd},` : ""} is gone, and Claude Code resumes a session only from the folder it ran in.`);
  return { id: session, resume: true, cwd, ...picked };
}

// Wait, up to the given seconds, for a process to exit.
export async function exited(pid: number, seconds = 15) {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
}
