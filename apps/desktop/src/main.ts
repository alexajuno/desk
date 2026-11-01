// desk's own window, an Electron app, as Linear's is ("originally this clones linear and eventually we can't avoid
// desktop app to utilize full potential", the user, 1 Nov). It holds desk's page from the server on 8790, the same page a
// browser shows, so a change to the page needs no new app; the app adds only what a page cannot have. Run:
// bin/desk-app (the launcher's desk entry does), or DESK_URL=<another desk> for a second one.
//
// Until 1 Nov desk opened as the user's Chrome in app mode (google-chrome-stable --app=http://localhost:8790/inbox), so
// the window keeps what that gave: one window, links to other sites in the user's browser, reload, zoom, back and
// forward, and the developer tools.
//
// It also holds Claude's tabs (tabs.ts), which Claude drives over the DevTools protocol on its port.
import { app, BrowserWindow, shell, type WebContents } from "electron";
import * as tabs from "./tabs.ts";

const HOME = new URL(process.env.DESK_URL || "http://localhost:8790/inbox");
// desk's own address, which a link may give as localhost or as 127.0.0.1, as the agents' API does.
const site = (url: string) => {
  const u = URL.parse(url);
  return u && `${u.protocol}//${u.hostname === "127.0.0.1" ? "localhost" : u.hostname}:${u.port}`;
};

let win: BrowserWindow | null = null;

app.commandLine.appendSwitch("remote-debugging-port", String(tabs.PORT)); // on 127.0.0.1 only

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
  app.on("window-all-closed", () => app.quit());
}

function open() {
  win = new BrowserWindow({
    title: "desk",
    width: 1440,
    height: 900,
    frame: false, // desk's page has its own head, and Hyprland tiles the window
    backgroundColor: "#121213", // desk's dark background, until the page draws
    webPreferences: { spellcheck: true },
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
    if (ours(url)) return { action: "allow", overrideBrowserWindowOptions: { frame: false, backgroundColor: "#121213" } };
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

// Chrome's keys that went with its menu, which the window has none of.
function shortcut(page: WebContents, key: Electron.Input): boolean {
  const ctrl = key.control || key.meta;
  if ((ctrl && key.code === "KeyR") || key.code === "F5") page.reload();
  else if (ctrl && key.shift && key.code === "KeyI") page.toggleDevTools();
  else if (key.code === "F12") page.toggleDevTools();
  else if (ctrl && (key.code === "Equal" || key.code === "NumpadAdd")) page.setZoomLevel(page.getZoomLevel() + 0.5);
  else if (ctrl && (key.code === "Minus" || key.code === "NumpadSubtract")) page.setZoomLevel(page.getZoomLevel() - 0.5);
  else if (ctrl && (key.code === "Digit0" || key.code === "Numpad0")) page.setZoomLevel(0);
  else if (key.alt && key.code === "ArrowLeft" && page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
  else if (key.alt && key.code === "ArrowRight" && page.navigationHistory.canGoForward()) page.navigationHistory.goForward();
  else return false;
  return true;
}
