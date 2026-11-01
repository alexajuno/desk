// Claude's tabs, which live in desk's app, the one Chrome that also shows them in a chat's Browser (desk issue "desk as
// a desktop app, as Linear's, with a real Chrome inside", 1 Nov). Claude's chrome tool drives them over the DevTools
// protocol on PORT, through the relay in desk's session host (apps/server/src/relay.ts), which asks the app here for
// each new tab, since Electron answers the protocol's Target.createTarget with "Not supported":
//
//     relay ── PUT /tabs {"url"} ──► SOCKET ──► a tab in a window of its own ──► {"target": "<its DevTools id>"}
//     relay ── GET / ──► SOCKET ──► {"context": "<the tabs' DevTools browser context>"}, the only one the relay shows Claude
//     desk ── GET /tabs/<id> ──► SOCKET ──► {"focused": true}, whether your keys are in the tab, which a chat's Browser shows
//
// A chat's Browser shows a tab itself, in desk's window over the Browser's box for it (show, below), at that box's size,
// as a Chrome tab takes its window's; your mouse and keys go straight to it, but for desk's own, which it hands back.
// A tab no chat shows waits in a window of its own on SCREEN, a virtual screen nobody sees, which the app makes and
// Hyprland draws as any other. A page draws only on a screen Hyprland shows, uncovered: on a hidden workspace Claude's
// screenshots took 1.4 s or never came, on a screen 0.3 s, and under another tab in the same window 1.2 s or never
// (1 Nov). Hyprland's config (~/.config/hypr/hyprland.lua, "desk's app") puts the screen out of the mouse's reach and
// the tabs' windows on it, and the user's screen scripts leave it out. The tabs keep their logins apart from desk's
// page, in PARTITION.
import { BaseWindow, session, WebContentsView, type BrowserWindow, type Input, type Rectangle, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { shortcut } from "./keys.ts";

export const PORT = Number(process.env.DESK_CHROME_PORT) || 9337; // a second desk app for testing takes another
const RUN = process.env.XDG_RUNTIME_DIR || tmpdir();
const SOCKET = process.env.DESK_APP_SOCKET || join(RUN, "desk-app.sock"); // in the user's own folder, which only they reach
const PARTITION = "persist:agents";
const SCREEN = "desk-tabs"; // the virtual screen's name, which Hyprland's config and the user's screen scripts know
const TITLE = "desk tabs"; // the tabs' windows', which Hyprland's rule knows them by
const SIZE = { width: 1440, height: 900 }; // a tab's, about the agents' Chrome's window, as the rule sizes it
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a new tab may start

type Tab = { id: string; view: WebContentsView; shelf: BaseWindow; host?: BrowserWindow };
const all = new Map<string, Tab>(); // Claude's tabs, by their DevTools id
const showing = new Map<BrowserWindow, Tab>(); // the tab each of desk's windows shows
const watched = new WeakSet<BrowserWindow>();
let context = "";
let quitting = false;

export async function start() {
  await screen();
  const agents = session.fromPartition(PARTITION);
  // As Chrome's, without Electron's and the app's names, which some sites refuse
  agents.setUserAgent(agents.getUserAgent().replace(/ (Electron|desk)\/\S+/g, ""));
  // A page Claude opens gets no camera, microphone, place or notifications, as headless Chrome gave it none
  agents.setPermissionRequestHandler((_page, permission, done) => done(permission === "clipboard-sanitized-write"));
  agents.setPermissionCheckHandler((_page, permission) => permission === "clipboard-sanitized-write");

  const probe = new WebContentsView({ webPreferences: { partition: PARTITION } });
  context = (await info(probe.webContents)).browserContextId;
  probe.webContents.close();
  listen();
}

export const quit = () => { quitting = true; };

// A new tab at the address, and its DevTools id.
async function open(url: string) {
  const { view, target } = shelve(new WebContentsView({ webPreferences: { partition: PARTITION, backgroundThrottling: false } }));
  const id = await target;
  view.webContents.loadURL(url).catch(() => {}); // a page that fails shows its error, as in Chrome
  return id;
}

// The view in a window of its own, as are the tabs it opens, until its page closes.
function shelve(view: WebContentsView) {
  const shelf = new BaseWindow({ ...SIZE, title: TITLE, show: true, backgroundColor: "#121213" });
  shelf.on("close", (e) => !quitting && e.preventDefault()); // closed from Hyprland, its tab would go with it
  shelf.removeMenu(); // Electron's own File, Edit, View, which took 34 px of the tab's height
  shelf.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, ...SIZE });
  const page = view.webContents, tab: Tab = { id: "", view, shelf };
  const target = info(page).then(({ targetId }) => (all.set(tab.id = targetId, tab), targetId));
  page.setWindowOpenHandler(() => ({
    action: "allow",
    createWindow: (o) => shelve(new WebContentsView({ webContents: (o as { webContents?: WebContents }).webContents, webPreferences: o.webPreferences })).view.webContents,
  }));
  page.on("before-input-event", (e, key) => tab.host && keyed(tab, key) && e.preventDefault());
  // An alert, a confirm or a prompt waits for Claude's answer or yours (the server's cast.ts), as headless Chrome's did:
  // Electron's own answer, a box of its own, came with no window to stand on and closed at once, unanswered (1 Nov).
  // Its answer is held while the page waits, which Chrome would give the page as "cancel" if it were let go.
  const dialogs = page as unknown as NodeJS.EventEmitter;
  let waits: unknown;
  dialogs.removeAllListeners("-run-dialog");
  dialogs.on("-run-dialog", (_info: unknown, answer: unknown) => { waits = answer; });
  page.on("did-start-navigation", (d) => d.isMainFrame && !d.isSameDocument && (waits = undefined));
  page.once("destroyed", () => {
    all.delete(tab.id);
    if (tab.host) leave(tab);
    shelf.destroy();
  });
  return { view, target };
}

// The tab at the place in one of desk's windows, in its pixels, or none: the tab the window showed goes back to its own
// window on SCREEN. A tab another window shows comes to this one, the last to ask.
export function show(host: BrowserWindow, target: string | null, at?: Rectangle) {
  const tab = target ? all.get(target) : undefined, was = showing.get(host);
  if (was && was !== tab) {
    leave(was);
    was.shelf.contentView.addChildView(was.view);
    was.view.setBounds({ x: 0, y: 0, ...SIZE });
  }
  if (!tab || !at) return;
  if (tab.host !== host) {
    if (tab.host) leave(tab);
    else tab.shelf.contentView.removeChildView(tab.view);
    host.contentView.addChildView(tab.view);
    tab.host = host;
    showing.set(host, tab);
    watch(host);
  }
  tab.view.setBounds(at);
}

const leave = (tab: Tab) => {
  const host = tab.host!;
  if (!host.isDestroyed()) host.contentView.removeChildView(tab.view);
  showing.delete(host);
  tab.host = undefined;
};

// desk's window lets go of its tab as its page goes, which says nothing as it goes: reloaded, gone to another site, or
// the window closed.
function watch(host: BrowserWindow) {
  if (watched.has(host)) return;
  watched.add(host);
  const away = () => show(host, null);
  host.on("close", away);
  host.webContents.on("did-start-navigation", (d) => d.isMainFrame && !d.isSameDocument && away());
  host.webContents.on("render-process-gone", away);
}

// A key pressed in a tab desk shows: Ctrl ` and Ctrl ⇧ B go on to desk, as from its terminal, and Ctrl L to the
// Browser's address, as Chrome's; Chrome's own keys do what they do there, reload, back and forward among them.
function keyed(tab: Tab, key: Input) {
  if (key.type !== "keyDown") return false;
  const ctrl = key.control && !key.alt && !key.meta;
  if (ctrl && (key.code === "Backquote" || (key.shift && key.code === "KeyB") || (!key.shift && key.code === "KeyL"))) {
    const desk = tab.host!.webContents;
    desk.focus();
    desk.send("key", tab.id, { key: key.key, code: key.code, ctrlKey: key.control, shiftKey: key.shift, altKey: key.alt, metaKey: key.meta });
    return true;
  }
  return shortcut(tab.view.webContents, key);
}

async function info(page: WebContents): Promise<{ targetId: string; browserContextId: string }> {
  page.debugger.attach("1.3");
  try {
    return (await page.debugger.sendCommand("Target.getTargetInfo")).targetInfo;
  } finally {
    page.debugger.detach();
  }
}

function listen() {
  rmSync(SOCKET, { force: true }); // left by an app that crashed: only the one app holding the lock gets here
  createServer((req, res) => {
    const reply = (status: number, body: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && req.url === "/") return reply(200, { context, port: PORT });
    const id = req.method === "GET" && /^\/tabs\/([0-9A-F]{32})$/.exec(req.url ?? "")?.[1];
    if (id) {
      const tab = all.get(id);
      return tab ? reply(200, { focused: Boolean(tab.host?.isFocused() && tab.view.webContents.isFocused()) }) : reply(404, { detail: "No such tab" });
    }
    if (req.method !== "PUT" || req.url !== "/tabs") return reply(404, { detail: "GET /, GET /tabs/<id> or PUT /tabs" });
    read(req).then((body) => {
      const url = (JSON.parse(body) as { url?: unknown }).url ?? "about:blank";
      if (typeof url !== "string" || !ADDRESS.test(url)) return reply(400, { detail: "An http or https address, or about:blank" });
      return open(url).then((target) => reply(200, { target }));
    }).catch((e: Error) => reply(500, { detail: e.message }));
  }).listen(SOCKET);
}

const read = (req: IncomingMessage) => new Promise<string>((done, fail) => {
  let body = "";
  req.on("data", (d: Buffer) => { body += d; }).on("end", () => done(body)).on("error", fail);
});

// The virtual screen, made unless an app before this one left it: it stays when the app quits, as an empty screen
// costs nothing, and each one added runs the user's screen scripts.
async function screen() {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  const hyprctl = (...args: string[]) => promisify(execFile)("hyprctl", args).then((r) => r.stdout);
  const there = async () => (JSON.parse(await hyprctl("monitors", "all", "-j")) as { name: string }[]).some((m) => m.name === SCREEN);
  if (await there()) return;
  await hyprctl("output", "create", "headless", SCREEN);
  for (let i = 0; i < 20 && !(await there()); i++) await sleep(100);
}
