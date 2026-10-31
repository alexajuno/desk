// A chat's terminal: a tmux session of its own, which the user types in from the chat's right half and Claude drives
// with tt, the interactive-terminal skill's helper ("agent can either drive it or i type it. it's a tmux session
// right", the user, 31 Oct). It lives on tt's own server, `tmux -L agent`, named after the chat, so `tt send chat-…`
// reaches it, and starts only when the user or Claude opens it ("can we just start terminal's session when needed?",
// 31 Oct). Its shell exiting ends it.
//
// The page draws it with xterm.js over a WebSocket, through a PTY running `tmux attach`, as VS Code's terminal does
// with node-pty. tmux keeps the history, which its own copy mode and the user's ~/.tmux.conf scroll and copy.
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { spawn as spawnPty } from "node-pty";
import type { WebSocket } from "ws";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import { run, which } from "./proc.ts";

const SOCKET = "agent";
// tt's config, read once as the server starts: the user's ~/.tmux.conf, then remain-on-exit and 50,000 lines of history.
const CONF = join(HOME, ".claude", "skills", "interactive-terminal", "assets", "tmux.conf");
const tmuxArgs = () => ["-L", SOCKET, ...(existsSync(CONF) ? ["-f", CONF] : [])];
const tmux = (...args: string[]) => run(["tmux", ...tmuxArgs(), ...args], { timeout: 10 });

// The chat's session's name: its chat's id, such as chat-5067a605, which tmux takes as it is.
export function nameOf(session: string): string {
  const chat = chats.agentChatOf(session);
  if (!chat) throw new NoTerminal("Only a desk chat has a terminal.");
  return chat.id;
}

export class NoTerminal extends Error {}

// "=name" names exactly that session, where a bare name would also match a longer one.
export const running = async (name: string) => (await tmux("has-session", "-t", `=${name}`)).code === 0;

// The chat's session's name and the folder its shell starts in, the one the chat works in.
export async function of(session: string): Promise<{ name: string; cwd: string }> {
  return { name: nameOf(session), cwd: (await chats.sessionRunsIn(session)) ?? HOME };
}

// Start the session when it is not running, a shell in cwd. Its tmux server, when this starts it, runs in a systemd
// scope of its own, as the session host does (hosted.ts): started from desk's own process, it would end with
// desk.service on every restart. Whether it started one now.
export async function start(name: string, cwd: string): Promise<{ name: string; started: boolean }> {
  if (await running(name)) return { name, started: false };
  const argv = ["tmux", ...tmuxArgs(), "new-session", "-d", "-s", name, "-c", existsSync(cwd) ? cwd : HOME, "-x", "120", "-y", "40", shell()];
  const scoped = which("systemd-run")
    ? ["systemd-run", "--user", "--scope", "--slice=agents.slice", `--unit=desk-tmux-${Date.now()}`, "--collect", "--quiet", "--", ...argv]
    : argv;
  const ran = await run(scoped, { env: await agents.sessionEnv(), timeout: 15 });
  if (ran.code !== 0 && !(await running(name))) throw new Error(`tmux did not start the session: ${ran.stderr.trim()}`);
  // tt's config keeps a finished program's pane; this one's shell exiting ends it. Its status line goes, since the
  // prompt says where you are, and the panel needs no window list.
  await tmux("set-option", "-t", `=${name}:`, "status", "off");
  await tmux("set-option", "-w", "-t", `=${name}:`, "remain-on-exit", "off");
  return { name, started: true };
}

// The page's end of it: a PTY attached to the session, its output to the socket as text, and the socket's messages to
// it, each a JSON {"in": "<keys>"} or {"cols": n, "rows": n}. The socket closes once the session ends or the PTY
// detaches, with "ended" when the session is gone.
export async function attach(socket: WebSocket, name: string, cols: number, rows: number) {
  if (!(await running(name))) return socket.close(4404, "ended");
  const pty = spawnPty("tmux", [...tmuxArgs(), "attach-session", "-t", `=${name}`], {
    name: "xterm-256color", cols: clamp(cols, 80), rows: clamp(rows, 24), cwd: HOME,
    env: { ...(await agents.sessionEnv()), TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  pty.onData((data) => socket.readyState === socket.OPEN && socket.send(data));
  pty.onExit(async () => {
    if (socket.readyState === socket.OPEN) socket.close(1000, (await running(name)) ? "detached" : "ended");
  });
  socket.on("message", (raw) => {
    let said: { in?: unknown; cols?: unknown; rows?: unknown };
    try {
      said = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof said.in === "string") pty.write(said.in);
    if (typeof said.cols === "number" && typeof said.rows === "number") pty.resize(clamp(said.cols, 80), clamp(said.rows, 24));
  });
  socket.on("close", () => pty.kill());
}

// The user's login shell, fish, named outright: tmux would otherwise start the $SHELL of whoever started its server,
// such as Claude's Bash tool, whose is bash.
const shell = () => userInfo().shell || process.env.SHELL || "/bin/sh";

const clamp = (n: number, fallback: number) => (Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), 1000) : fallback);
