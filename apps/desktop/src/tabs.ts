// Claude's tabs, which live in desk's app, the one Chrome that also shows them in a chat's Browser (desk issue "desk as
// a desktop app, as Linear's, with a real Chrome inside", 1 Nov). Claude's chrome tool drives them over the DevTools
// protocol on PORT, through the relay in desk's session host (apps/server/src/relay.ts), which asks the app here for
// each new tab, since Electron answers the protocol's Target.createTarget with "Not supported":
//
//     relay ── PUT /tabs {"url"} ──► SOCKET ──► a tab in a window of its own ──► {"target": "<its DevTools id>"}
//     relay ── GET / ──► SOCKET ──► {"context": "<the tabs' DevTools browser context>"}, the only one the relay shows Claude
//     desk ── GET /tabs/<id> ──► SOCKET ──► {"focused": true}, whether your keys are in the tab, which a chat's Browser shows
//     relay ── POST /tabs/<id>/shot {place, scale, format} ──► SOCKET ──► {"data": "<base64>"}, Claude's screenshot (shot)
//     bin/desk-app ── POST /window ──► SOCKET ──► desk's window, made or shown again (main.ts)
//
// A chat's Browser shows a tab itself, in desk's window over the Browser's box for it (show, below), at that box's size,
// as a Chrome tab takes its window's; your mouse and keys go straight to it, but for desk's own, which it hands back.
// A tab no chat shows waits in a window of its own on SCREEN, a virtual screen nobody sees, which the app makes and
// Hyprland draws as any other. A page draws only on a screen Hyprland shows, uncovered: on a hidden workspace Claude's
// screenshots took 1.4 s or never came, on a screen 0.3 s, and under another tab in the same window 1.2 s or never
// (1 Nov). Hyprland's config (~/.config/hypr/hyprland.lua, "desk's app") puts the screen out of the mouse's reach and
// the tabs' windows on it, and the user's screen scripts leave it out. The tabs keep their logins apart from desk's
// page, in PARTITION, which takes the user's own Chrome's as the app starts (logins.ts).
import { BaseWindow, nativeImage, session, WebContentsView, type BrowserWindow, type Input, type NativeImage, type Rectangle, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { shortcut } from "./keys.ts";
import * as logins from "./logins.ts";

export const PORT = Number(process.env.DESK_CHROME_PORT) || 9337; // a second desk app for testing takes another
const RUN = process.env.XDG_RUNTIME_DIR || tmpdir();
const SOCKET = process.env.DESK_APP_SOCKET || join(RUN, "desk-app.sock"); // in the user's own folder, which only they reach
const PARTITION = "persist:agents";
const SCREEN = "desk-tabs"; // the virtual screen's name, which Hyprland's config and the user's screen scripts know
const TITLE = "desk tabs"; // the tabs' windows', which Hyprland's rule knows them by
const SIZE = { width: 1440, height: 900 }; // a tab's, about the agents' Chrome's window, as the rule sizes it
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a new tab may start
const BIGGEST = 16384; // CSS px on a side of a screenshot beyond the view, about as big as a picture Chrome draws may be

type Tab = { id: string; view: WebContentsView; shelf: BaseWindow; host?: BrowserWindow };
const all = new Map<string, Tab>(); // Claude's tabs, by their DevTools id
const showing = new Map<BrowserWindow, Tab>(); // the tab each of desk's windows shows
const watched = new WeakSet<BrowserWindow>();
let context = "";
let quitting = false;

// The tabs' screen, logins and socket, on which a call for desk's window brings it (main.ts).
export async function start(showWindow: () => void) {
  await screen();
  const agents = session.fromPartition(PARTITION);
  // As Chrome's, without Electron's and the app's names, which some sites refuse
  agents.setUserAgent(agents.getUserAgent().replace(/ (Electron|desk)\/\S+/g, ""));
  // A page Claude opens gets no camera, microphone, place or notifications, as headless Chrome gave it none
  agents.setPermissionRequestHandler((_page, permission, done) => done(permission === "clipboard-sanitized-write"));
  agents.setPermissionCheckHandler((_page, permission) => permission === "clipboard-sanitized-write");

  const probe = new WebContentsView({ webPreferences: { partition: PARTITION } });
  context = (await info(probe.webContents)).browserContextId;
  await logins.bring(probe.webContents).then(
    (n) => console.log(`your logins: ${n} cookies from your Chrome`),
    (e: Error) => console.log(`no logins from your Chrome: ${e.message}`),
  );
  probe.webContents.close();
  listen(showWindow);
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
// window on SCREEN. A tab another window shows comes to this one, the last to ask. Aside, it keeps the place's size but
// stands out of sight, left of the window, while desk shows a picture of it (still, below) under a menu of its own,
// which the tab would cover: the page goes on drawing, for Claude's screenshots, and keeps its size, so nothing in it
// moves.
export function show(host: BrowserWindow, target: string | null, at?: Rectangle, aside = false) {
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
  tab.view.setBounds(aside ? { ...at, x: -at.width - 100 } : at);
}

// A picture of the tab as it shows, for desk to show in its place while the tab stands aside: a BMP, the pixels as they
// are, which takes 1 ms to make where a PNG took 42 (1 Nov), top row first.
export async function still(target: string) {
  const image = await all.get(target)?.view.webContents.capturePage();
  const scale = image?.getScaleFactors()[0] ?? 1, { width, height } = image?.getSize(scale) ?? { width: 0, height: 0 };
  const pixels = image?.toBitmap({ scaleFactor: scale }); // blue, green, red and alpha, each a byte, as BMP keeps them
  if (!pixels || !width || pixels.length !== width * height * 4) return null;
  const head = Buffer.alloc(54);
  head.write("BM");
  head.writeUInt32LE(54 + pixels.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18);
  head.writeInt32LE(-height, 22); // top row first
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(32, 28);
  head.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([head, pixels]);
}

// A screenshot of the tab for Claude, which the relay asks for in place of Chrome's own: Chrome's waits for the screen
// to show the frame, which a locked screen never does, and hung there, once for over 4 minutes, while this answered in
// 26 to 103 ms (2 Nov). The part of the page at the place, in its CSS pixels from the view's corner, or from the page's
// for one beyond the view, as a full page is, sized and encoded as Chrome's: its width times the scale times the screen's.
export interface Shot { x: number; y: number; width: number; height: number; scale: number; format: "png" | "jpeg"; quality?: number; beyond?: boolean }

export async function shot(target: string, o: Shot) {
  const tab = all.get(target);
  if (!tab) throw new Error("No such tab");
  const { view } = tab, was = view.getBounds();
  const rect = { x: Math.round(o.x), y: Math.round(o.y), width: Math.round(o.width), height: Math.round(o.height) };
  // Beyond the view, the view grows to hold the place for the moment, as Chrome's own grows the page, its page then not
  // scrolled. One desk shows grows where it is, over the Browser's foot: out of the window it never drew at its new size
  // (2 Nov). A place bigger than the view, grown or not, gives what the view holds: a page taller than it may grow gives
  // its top.
  const grow = o.beyond && (rect.x + rect.width > was.width || rect.y + rect.height > was.height);
  const width = grow ? Math.min(Math.max(was.width, rect.x + rect.width), BIGGEST) : was.width;
  const height = grow ? Math.min(Math.max(was.height, rect.y + rect.height), BIGGEST) : was.height;
  if (grow) view.setBounds({ x: tab.host ? was.x : 0, y: tab.host ? was.y : 0, width, height });
  rect.width = Math.max(1, Math.min(rect.width, width - rect.x));
  rect.height = Math.max(1, Math.min(rect.height, height - rect.y));
  try {
    // The first picture under a locked screen is the frame before the page's last change (2 Nov): the second is as it is.
    // A view grown takes a few frames to draw at its new size: until it does, its picture is cut to its old size, and
    // it has the place's shape only once it has.
    const pixels = (image: NativeImage) => image.getSize(image.getScaleFactors()[0] ?? 1);
    let image = await view.webContents.capturePage(rect);
    for (let i = 0; i < (grow ? 20 : 1); i++) {
      image = await view.webContents.capturePage(rect);
      const { width, height } = pixels(image);
      if (!grow || Math.abs(height / width - rect.height / rect.width) < 0.01) break;
      await sleep(50);
    }
    // The picture is in the screen's pixels, which Electron calls scale 1 (2 Nov, at the laptop's scale 2): the screen's
    // scale is its width over the place's, and it is sized from there as one picture at scale 1, never stretched: a
    // view that did not grow in time gives what it had.
    const size = pixels(image), screen = size.width / rect.width;
    image = nativeImage.createFromBitmap(image.toBitmap({ scaleFactor: image.getScaleFactors()[0] ?? 1 }), size);
    const want = { width: Math.max(1, Math.round(rect.width * o.scale * screen)), height: Math.max(1, Math.round(Math.min(rect.height, size.height / screen) * o.scale * screen)) };
    if (want.width !== size.width || want.height !== size.height) image = image.resize({ ...want, quality: "best" });
    return (o.format === "jpeg" ? image.toJPEG(o.quality ?? 80) : image.toPNG()).toString("base64");
  } finally {
    if (grow) view.setBounds(was);
  }
}

const leave = (tab: Tab) => {
  const host = tab.host!;
  if (!host.isDestroyed()) host.contentView.removeChildView(tab.view);
  showing.delete(host);
  tab.host = undefined;
};

// desk's window lets go of its tab as its page goes, which says nothing as it goes: reloaded, gone to another site, or
// the window closed, or its page closed it, as window.close() does with no close of the window's; and as it hides, where
// the tab would stop drawing.
function watch(host: BrowserWindow) {
  if (watched.has(host)) return;
  watched.add(host);
  const away = () => show(host, null);
  host.on("close", away);
  host.on("hide", away);
  host.webContents.once("destroyed", away);
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

function listen(showWindow: () => void) {
  rmSync(SOCKET, { force: true }); // left by an app that crashed: only the one app holding the lock gets here
  createServer((req, res) => {
    const reply = (status: number, body: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && req.url === "/") return reply(200, { context, port: PORT });
    if (req.method === "POST" && req.url === "/window") return (showWindow(), reply(200, {})); // bin/desk-app's
    const id = req.method === "GET" && /^\/tabs\/([0-9A-F]{32})$/.exec(req.url ?? "")?.[1];
    if (id) {
      const tab = all.get(id);
      return tab ? reply(200, { focused: Boolean(tab.host?.isFocused() && tab.view.webContents.isFocused()) }) : reply(404, { detail: "No such tab" });
    }
    const shooting = req.method === "POST" && /^\/tabs\/([0-9A-F]{32})\/shot$/.exec(req.url ?? "")?.[1];
    if (shooting) { // the relay's, for Claude's screenshot
      return read(req).then((body) => shot(shooting, JSON.parse(body) as Shot)).then((data) => reply(200, { data }))
        .catch((e: Error) => reply(e.message === "No such tab" ? 404 : 500, { detail: e.message }));
    }
    if (req.method !== "PUT" || req.url !== "/tabs") return reply(404, { detail: "GET /, GET /tabs/<id>, PUT /tabs, POST /tabs/<id>/shot or POST /window" });
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
