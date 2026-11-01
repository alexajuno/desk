// Claude's tabs, which live in desk's app, the one Chrome that also shows them in a chat's Browser (desk issue "desk as
// a desktop app, as Linear's, with a real Chrome inside", 1 Nov). Claude's chrome tool drives them over the DevTools
// protocol on PORT, through the relay in desk's session host (apps/server/src/relay.ts), which asks the app here for
// each new tab, since Electron answers the protocol's Target.createTarget with "Not supported":
//
//     relay ── PUT /tabs {"url"} ──► SOCKET ──► a tab in a window of its own ──► {"target": "<its DevTools id>"}
//     relay ── GET / ──► SOCKET ──► {"context": "<the tabs' DevTools browser context>"}, the only one the relay shows Claude
//
// A tab no chat shows waits in a window of its own on SCREEN, a virtual screen nobody sees, which the app makes and
// Hyprland draws as any other. A page draws only on a screen Hyprland shows, uncovered: on a hidden workspace Claude's
// screenshots took 1.4 s or never came, on a screen 0.3 s, and under another tab in the same window 1.2 s or never
// (1 Nov). Hyprland's config (~/.config/hypr/hyprland.lua, "desk's app") puts the screen out of the mouse's reach and
// the tabs' windows on it, and the user's screen scripts leave it out. The tabs keep their logins apart from desk's
// page, in PARTITION.
import { BaseWindow, session, WebContentsView, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export const PORT = Number(process.env.DESK_CHROME_PORT) || 9337; // a second desk app for testing takes another
const RUN = process.env.XDG_RUNTIME_DIR || tmpdir();
const SOCKET = process.env.DESK_APP_SOCKET || join(RUN, "desk-app.sock"); // in the user's own folder, which only they reach
const PARTITION = "persist:agents";
const SCREEN = "desk-tabs"; // the virtual screen's name, which Hyprland's config and the user's screen scripts know
const TITLE = "desk tabs"; // the tabs' windows', which Hyprland's rule knows them by
const SIZE = { width: 1440, height: 900 }; // a tab's, about the agents' Chrome's window, as the rule sizes it
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a new tab may start

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
  const view = shelve(new WebContentsView({ webPreferences: { partition: PARTITION, backgroundThrottling: false } }));
  const { targetId } = await info(view.webContents);
  view.webContents.loadURL(url).catch(() => {}); // a page that fails shows its error, as in Chrome
  return targetId;
}

// The view in a window of its own, as are the tabs it opens, until its page closes.
function shelve(view: WebContentsView) {
  const window = new BaseWindow({ ...SIZE, title: TITLE, show: true, backgroundColor: "#121213" });
  window.on("close", (e) => !quitting && e.preventDefault()); // closed from Hyprland, its tab would go with it
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, ...SIZE });
  const page = view.webContents;
  page.setWindowOpenHandler(() => ({
    action: "allow",
    createWindow: (o) => shelve(new WebContentsView({ webContents: (o as { webContents?: WebContents }).webContents, webPreferences: o.webPreferences })).webContents,
  }));
  page.once("destroyed", () => window.destroy());
  return view;
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
    if (req.method !== "PUT" || req.url !== "/tabs") return reply(404, { detail: "GET / or PUT /tabs" });
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
