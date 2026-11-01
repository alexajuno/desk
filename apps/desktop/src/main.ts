// desk's own window, an Electron app, as Linear's is ("originally this clones linear and eventually we can't avoid
// desktop app to utilize full potential", the user, 1 Nov). It holds desk's page from the server on 8790, the same page a
// browser shows, so a change to the page needs no new app; the app adds only what a page cannot have. Run:
// bin/desk-app (the launcher's desk entry does), or DESK_URL=<another desk> for a second one.
//
// Until 1 Nov desk opened as the user's Chrome in app mode (google-chrome-stable --app=http://localhost:8790/inbox), so
// the window keeps what that gave: one window, links to other sites in the user's browser, reload, zoom, back and
// forward, and the developer tools.
//
// It also holds Claude's tabs (tabs.ts), which Claude drives over the DevTools protocol on its port, and which a chat's
// Browser in desk's page shows in its place, through what the page gets from the app (preload.cjs).
import { app, BrowserWindow, ipcMain, shell, type Rectangle, type WebContents } from "electron";
import { join } from "node:path";
import { shortcut } from "./keys.ts";
import * as tabs from "./tabs.ts";

const HOME = new URL(process.env.DESK_URL || "http://localhost:8790/inbox");
// desk's own address, which a link may give as localhost or as 127.0.0.1, as the agents' API does.
const site = (url: string) => {
  const u = URL.parse(url);
  return u && `${u.protocol}//${u.hostname === "127.0.0.1" ? "localhost" : u.hostname}:${u.port}`;
};

const PRELOAD = join(import.meta.dirname, "preload.cjs");

let win: BrowserWindow | null = null;

app.commandLine.appendSwitch("remote-debugging-port", String(tabs.PORT)); // on 127.0.0.1 only
// The cookies' key in the user's keyring, as their Chrome's (logins.ts); on a desktop it does not know, as Hyprland,
// Electron's Chrome would use the key every Chrome has, "peanuts"
app.commandLine.appendSwitch("password-store", "gnome-libsecret");

// One desk at a time: opening it again brings back the window it has.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!win) return open();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    open();
    return tabs.start();
  }).catch((e: Error) => console.log(`no tabs for Claude: ${e.message}`));
  app.on("before-quit", tabs.quit);
  ipcMain.on("tab", (e, target: unknown, at: unknown) => {
    const host = BrowserWindow.fromWebContents(e.sender);
    if (!host || e.senderFrame !== e.sender.mainFrame || site(e.sender.getURL()) !== site(HOME.href)) return;
    tabs.show(host, typeof target === "string" ? target : null, place(at, e.sender.getZoomFactor()));
  });
  app.on("window-all-closed", () => app.quit());
}

function open() {
  win = new BrowserWindow({
    title: "desk",
    width: 1440,
    height: 900,
    frame: false, // desk's page has its own head, and Hyprland tiles the window
    backgroundColor: "#121213", // desk's dark background, until the page draws
    webPreferences: { spellcheck: true, preload: PRELOAD },
  });
  win.removeMenu();
  win.on("closed", () => { win = null; });
  keep(win.webContents);
  void win.loadURL(HOME.href);
}

// A page of desk's own stays in desk, in a window of its own when it asks for one; any other site opens in the user's
// browser, as a link from Chrome's app window did.
function keep(page: WebContents) {
  const ours = (url: string) => site(url) === site(HOME.href);
  page.setWindowOpenHandler(({ url }) => {
    if (ours(url)) return { action: "allow", overrideBrowserWindowOptions: { frame: false, backgroundColor: "#121213", webPreferences: { preload: PRELOAD } } };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  page.on("will-navigate", (e) => {
    if (ours(e.url)) return;
    e.preventDefault();
    if (/^https?:/.test(e.url)) void shell.openExternal(e.url);
  });
  page.on("did-create-window", (w) => { w.removeMenu(); keep(w.webContents); });
  page.on("before-input-event", (e, key) => {
    if (key.type !== "keyDown") return;
    const done = shortcut(page, key);
    if (done) e.preventDefault();
  });
}

// The place desk's page gives a tab, in its own pixels, in the window's, which desk's zoom makes bigger or smaller.
function place(at: unknown, zoom: number): Rectangle | undefined {
  const { x, y, width, height } = (at ?? {}) as Record<string, unknown>;
  const all = [x, y, width, height].map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * zoom) : NaN));
  return all.every((n) => !Number.isNaN(n)) && all[2] > 0 && all[3] > 0 ? { x: all[0], y: all[1], width: all[2], height: all[3] } : undefined;
}
