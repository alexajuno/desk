// The one Claude Code session bound to an issue, from its plan to its landing (desk/agents.py, which says how each step
// works and what was checked on Claude Code 2.1.285 and 2.1.300).
//
//   Plan       claude --bg in the issue's folder, with no -w: the repo's own rules say where the session works. The
//              session plans by the issue's protocol and keeps the plan in plan.md.
//   "go"       said in the chat: the same session carries out the plan, then writes its review card in result.md.
//   Approve    the same session lands the work by the repo's rules (`claude stop`, then `claude --bg --resume <id>
//              "<land it>"`, with no other flags).
//   Jump back  focus the session's kitty tab if it is open, else open one.
import { existsSync, readFileSync, renameSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { detach, run, shJoin, sleep, which } from "./proc.ts";
import { BRIEF_PROMPT, BRIEF_STEPS, CHAT_PLAN_PROMPT, fill, GO_PROMPT, LAND_PROMPT, PLAN_PROMPT, TOLD } from "./prompts.ts";

export async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const r = await run(["git", ...args], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null; // no folder, or no git
  }
}

// `claude --bg` and `claude attach` start Claude Code's daemon as their child when none is running, and every
// background session then runs under that daemon. desk runs as desk.service, whose restart stops everything in its
// cgroup, so on 15 Oct one restart of desk killed every running session; in a scope of its own the daemon outlives desk.
// --expand-environment=no: systemd-run otherwise expands "$" in the arguments, the prompt included.
export function ownScope(command: string[], slice = "agents.slice"): string[] {
  if (!which("systemd-run")) return command;
  return ["systemd-run", "--user", "--scope", `--slice=${slice}`, "--collect", "--quiet", "--expand-environment=no", "--", ...command];
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

// Every session Claude Code knows, keyed by short id and by full session id. A page asks several times, so an answer
// under a second old is reused (`claude agents` takes about 0.15 s); fresh asks again, as right after starting one.
export async function live(fresh = false): Promise<Map<string, Row>> {
  if (!fresh && performance.now() / 1000 - seen[0] < 1) return seen[1];
  let rows: Row[];
  try {
    const r = await run(["claude", "agents", "--json", "--all"], { timeout: 15 });
    rows = JSON.parse(r.stdout || "[]");
  } catch {
    return new Map();
  }
  const byKey = new Map<string, Row>();
  for (const row of rows) for (const key of [row.id, row.sessionId]) if (key) byKey.set(key, row);
  seen = [performance.now() / 1000, byKey];
  return byKey;
}

export const liveRow = async (session: string | null | undefined, fresh = false): Promise<Row> =>
  (session ? (await live(fresh)).get(session) : undefined) ?? {};

// Where the session stands, from its row in `claude agents --json`: working while a turn runs (status busy), idle while
// its process lives between turns, stopped with no process, whatever `state` says; none when it does not list.
export function status(row: Row): string {
  if (!row || !Object.keys(row).length) return "none";
  if (row.status === "busy") return "working";
  return row.pid ? "idle" : "stopped";
}

// kitty.conf has `listen_on unix:/tmp/mykitty`, and kitty adds -<its pid> to the socket, so each running kitty answers
// on one of these.
async function kittySockets(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  try {
    return readdirSync("/tmp").filter((n) => n.startsWith("mykitty-")).map((n) => `/tmp/${n}`).sort();
  } catch {
    return [];
  }
}

// Run a remote control command in one kitty; when it works, bring that kitty to the front.
async function kitty(socket: string, ...args: string[]): Promise<boolean> {
  if ((await run(["kitty", "@", "--to", `unix:${socket}`, ...args], { timeout: 10 })).code) return false;
  // Hyprland 0.56 takes Lua after `dispatch`.
  const pid = socket.slice(socket.lastIndexOf("-") + 1);
  const focus = await run(["hyprctl", "dispatch", `hl.dsp.focus({ window = "pid:${pid}" })`], { timeout: 10, env: await sessionEnv() });
  if (focus.code) throw new Error(`Opened in kitty, but Hyprland did not switch to it: ${focus.stdout.trim()}`);
  return true;
}

// Focus the kitty tab desk opened for the issue, if it is still open.
async function focusTab(i: Issue): Promise<boolean> {
  for (const socket of await kittySockets()) if (await kitty(socket, "focus-tab", "--match", `var:^desk_issue$=^${i.slug}$`)) return true;
  return false;
}

// Run the command in a new tab of the running kitty, marked with the issue's slug so focusTab finds it; with no kitty
// running, in a new kitty window, marked the same way through a session.
async function terminal(cwd: string, i: Issue, ...command: string[]) {
  const launch = ["--tab-title", i.title, "--cwd", cwd, "--var", `desk_issue=${i.slug}`, ...command];
  for (const socket of await kittySockets()) if (await kitty(socket, "launch", "--type=tab", ...launch)) return;
  detach(ownScope(["kitty", "--title", i.title, "--session", "-"], "app.slice"), { env: await sessionEnv(), input: `launch ${shJoin(launch)}\n` });
}

const paths = (i: Issue, folder: string) => ({ title: i.title, file: join(folder, "issue.md"), plan: join(folder, "plan.md"), dir: folder });

// Claude Code refused to start a session because nobody accepted its trust prompt in the folder.
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

export async function background(cwd: string, command: string[]): Promise<string> {
  const r = await run(ownScope(command), { cwd, timeout: 60, env: await sessionEnv() });
  // With FORCE_COLOR set, the id comes wrapped in colour codes: "backgrounded · \x1b[36mf72e9ccb\x1b[39m · <name>".
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  if (out.toLowerCase().includes("workspace not trusted")) throw new TrustError(`Workspace not trusted: ${cwd}`);
  const m = /backgrounded · ([0-9a-f]{8})/.exec(out);
  if (!m) throw new Error(out.trim() || "claude --bg printed no id");
  return m[1];
}

// Start the issue's session in the background in its folder, whose repo's rules say where to work; the short id.
const newSession = (i: Issue, prompt: string) => background(workdir(i), ["claude", "--bg", "-n", [...i.title].slice(0, 40).join(""), prompt]);

export async function sessionId(short: string): Promise<string> {
  return (await live(true)).get(short)?.sessionId ?? short;
}

// The session's first prompt, by the issue's protocol: a design doc planned with the user, or a brief, after which it
// waits for "go" or goes on at once. chat is the Agent chat it came from, if any.
export function planPrompt(i: Issue, folder: string, chat = ""): string {
  const p = paths(i, folder);
  const runs = store.runs(i);
  if (runs === "design") return chat ? fill(CHAT_PLAN_PROMPT, { chat, ...p }) : fill(PLAN_PROMPT, p);
  const [how, then] = BRIEF_STEPS[runs];
  const told = chat ? fill(TOLD, { chat }) : "";
  return fill(BRIEF_PROMPT, { protocol: runs, how, then, told, ...p });
}

// Plan, or Start: the issue's session plans it by its protocol; its session id.
export const start = async (i: Issue, folder: string) => sessionId(await newSession(i, planPrompt(i, folder)));
// Start the issue's session straight on its written plan, as the desk agent does; its session id.
export const runPlan = async (i: Issue, folder: string) => sessionId(await newSession(i, fill(GO_PROMPT, paths(i, folder))));
// Start the issue's session to plan from the Agent chat, then wait, or go on at once for a quick issue.
export const planFromChat = async (i: Issue, folder: string, chat: string) => sessionId(await newSession(i, planPrompt(i, folder, chat)));
// The desk agent starts an issue that already has a session: the same session carries out the plan.
export const go = (i: Issue, folder: string) => carryOn(i, fill(GO_PROMPT, paths(i, folder)));
// Approve: the issue's own session lands its work by the repo's rules.
export const land = (i: Issue, folder: string) => carryOn(i, fill(LAND_PROMPT, paths(i, folder)));
// Give the issue's session one message, as the user would in its chat.
export const say = (i: Issue, message: string) => carryOn(i, message);

// Give the issue's own session its next message, in the background, as the same session.
async function carryOn(i: Issue, prompt: string) {
  const row = await liveRow(i.session, true);
  if (row.kind === "interactive") throw new Error("This session is open in a terminal. Close that tab, then try again.");
  // `state` stays "working" while a session waits for you between turns; `status` busy is a turn actually running.
  if (row.status === "busy") throw new Error("The session is still working. Wait until it is done, then try again.");
  if (row.pid) {
    await run(["claude", "stop", row.id!], { timeout: 30 });
    // `claude stop` returns about half a second before the process exits; a resume in that gap "started a copy".
    await exited(row.pid);
  }
  const { sessionRunsIn } = await import("./chats.ts");
  const short = await background((await sessionRunsIn(i.session)) ?? workdir(i), ["claude", "--bg", "--resume", i.session!, prompt]);
  if (!i.session!.startsWith(short)) {
    // Left running, the copy would work on the issue's branch where desk cannot see it (15 Oct).
    await run(["claude", "stop", short], { timeout: 30 });
    throw new Error(`Claude Code started a copy (${short}) instead of continuing the session; desk stopped the copy. Try again.`);
  }
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

// Focus the issue's session in kitty, or open it there.
export async function jumpBack(i: Issue) {
  if (await focusTab(i)) return;
  const row = await liveRow(i.session);
  if (row.kind === "background" && (row.state === "working" || row.state === "done")) await terminal(row.cwd || workdir(i), i, "claude", "attach", row.id!);
  else if (row.kind === "interactive") throw new Error("This session is already open in a terminal.");
  else await terminal(await resumeDir(i), i, "claude", "--resume", i.session!);
}

// Where to `claude --resume` the issue's session: the folder an Agent chat's runs in, the worktree desk made with
// `claude -w` for an old one's, else the issue's folder.
export async function resumeDir(i: Issue): Promise<string> {
  const { sessionRunsIn } = await import("./chats.ts");
  const worktree = join(workdir(i), ".claude", "worktrees", `desk-${i.slug.slice(0, 40)}`);
  return (await sessionRunsIn(i.session)) ?? (existsSync(worktree) ? worktree : workdir(i));
}
