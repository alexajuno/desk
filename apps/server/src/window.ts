// A floating kitty window over desk, on the Hyprland workspace the user is on, for a Claude Code session: desk's agent
// chats and an issue's Open chat (ported from desk/window.py, which said what was checked on Hyprland 0.56.2). Each window is found
// again by its class, so one session never opens in two windows from desk.
import * as agents from "./agents.ts";
import type { Issue } from "./issues.ts";
import { run, shJoin, sleep, which } from "./proc.ts";

async function hyprctl(...args: string[]): Promise<string> {
  if (!which("hyprctl")) throw new Error("A chat opens in a floating window, which needs Hyprland.");
  const r = await run(["hyprctl", ...args], { timeout: 10, env: await agents.sessionEnv() });
  if (r.code) throw new Error(`Hyprland said: ${(r.stdout + r.stderr).trim()}`);
  return r.stdout;
}

// Hyprland 0.56 takes Lua after `dispatch` and answers "ok".
async function dispatch(lua: string) {
  const said = (await hyprctl("dispatch", lua)).trim();
  if (said !== "ok") throw new Error(`Hyprland said: ${said}`);
}

interface Client { class: string; title: string; address: string; workspace: { id: number } }
const clients = async (): Promise<Client[]> => JSON.parse(await hyprctl("clients", "-j"));

// Whether a window of that class is open.
export const isOpen = async (name: string) => (await clients()).some((c) => c.class === name);

// The class of the window in front, the one with the focus.
export async function inFront(): Promise<string> {
  return JSON.parse((await hyprctl("activewindow", "-j")) || "{}").class ?? "";
}

// Wait, up to the given seconds, for the window of that class to close; whether it has.
export async function closed(name: string, seconds = 5): Promise<boolean> {
  const deadline = performance.now() + seconds * 1000;
  while (await isOpen(name)) {
    if (performance.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

// Bring the window of that class to the workspace the user is on and focus it; false when there is none.
export async function focus(name: string): Promise<boolean> {
  const here = JSON.parse(await hyprctl("activeworkspace", "-j")).id;
  for (const c of await clients()) {
    if (c.class !== name) continue;
    const window = `address:${c.address}`;
    if (c.workspace.id !== here) await dispatch(`hl.dsp.window.move({ workspace = "${here}", window = "${window}" })`);
    await dispatch(`hl.dsp.focus({ window = "${window}" })`);
    return true;
  }
  return false;
}

// Go to the window whose title starts with the page's ("Inbox · desk - Google Chrome"), on its own workspace, and focus
// it; false when there is none. The browser renames its window a moment after the tab changes, so this looks again for
// up to a second.
export async function raiseTitled(title: string): Promise<boolean> {
  for (let n = 0; n < 10; n++) {
    for (const c of await clients()) {
      if (title && c.title.startsWith(title)) {
        await dispatch(`hl.dsp.focus({ window = "address:${c.address}" })`);
        return true;
      }
    }
    await sleep(100);
  }
  return false;
}

// Run the command in a new floating kitty window of that class, centred on the user's screen.
export async function launch(name: string, title: string, cwd: string, argv: string[]) {
  const screen = (JSON.parse(await hyprctl("monitors", "-j")) as { focused: boolean; width: number; height: number; scale: number; transform?: number }[])
    .find((m) => m.focused)!;
  let wide = screen.width / screen.scale, high = screen.height / screen.scale;
  if ((screen.transform ?? 0) % 2) [wide, high] = [high, wide];
  const size = `${Math.round(Math.min(1100, wide * 0.85))} ${Math.round(Math.min(760, high * 0.85))}`;
  // Hyprland's PATH may not hold ~/.local/bin, where claude lives; in a scope of its own Claude Code's daemon, which
  // `claude attach` may start, outlives the window.
  const command = agents.ownScope([which(argv[0]) ?? argv[0], ...argv.slice(1)]);
  const line = shJoin([which("kitty") ?? "kitty", "--class", name, "--title", title.replace(/[\x00-\x1f]/g, ""), "--directory", cwd, ...command]);
  await dispatch(`hl.dsp.exec_cmd(${JSON.stringify(line)}, { float = true, size = "${size}", center = true })`);
}

// The session's window: brought to the user if open, else opened.
export async function session(name: string, title: string, cwd: string, argv: string[]) {
  if (!(await focus(name))) await launch(name, title, cwd, argv);
}

// The claude command and folder for an issue's session, as Jump back picks them, but blocked counts as live too: a
// session waiting for you is the one to attach to (ported from desk/terminal.py, command).
async function command(i: Issue): Promise<[string[], string]> {
  if (!i.session || !/^(?:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})$/.test(i.session)) throw new Error("This issue has no session yet.");
  const row = await agents.liveRow(i.session, true);
  if (row.kind === "background" && ["working", "done", "blocked"].includes(row.state ?? "")) return [["claude", "attach", row.id!], row.cwd || agents.workdir(i)];
  if (row.kind === "interactive") throw new Error("This session is already open in a terminal. Close that one first.");
  return [["claude", "--resume", i.session], await agents.resumeDir(i)];
}

// The issue's Open chat. A session that began as one of desk's agent chats opens that chat's window.
export async function issue(i: Issue) {
  const chats = await import("./chats.ts");
  const chat = await chats.windowOf(i.session);
  if (chat) return chats.openWindow(chat);
  const [argv, cwd] = await command(i);
  await session(`desk-issue-${i.slug}`, `desk · ${i.title}`, cwd, argv);
}
