// desk's page in an Electron window, kept beside the native window (apps/native) until that one has every screen ("i
// still wanna use desk as electron app until it's completed. can i have two versions?", the user, 8 Nov). It holds the
// same page a browser shows from the server on 8790, so a change to the page needs no new app. Run it from the launcher's
// "desk (Electron)" (desk-electron.desktop), or with DESK_URL=<another desk> for a second one.
//
// It is only a window: the native window keeps the Inbox's pop-ups and running hidden, so this one asks
// for no notifications, which would come twice, and quits when closed.
import { app, BrowserWindow, session, shell, type WebContents } from "electron";
import { rightClick, shortcut } from "./keys.ts";

const HOME = new URL(process.env.DESK_URL || "http://localhost:8790/inbox");
// desk's own address, which a link may give as localhost or as 127.0.0.1, as the agents' API does.
const site = (url: string) => {
  const u = URL.parse(url);
  return u && `${u.protocol}//${u.hostname === "127.0.0.1" ? "localhost" : u.hostname}:${u.port}`;
};

// The key of the cookies the app keeps on disk in the user's keyring, as their Chrome's (fuses.ts); on a desktop it does
// not know, as Hyprland, Electron's Chrome would use the key every Chrome has, "peanuts"
app.commandLine.appendSwitch("password-store", "gnome-libsecret");

let win: BrowserWindow | null = null;

// One at a time: opening it again brings back the window it has.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", show);
  void app.whenReady().then(() => {
    // The native window tells the Inbox's news; the page here sees Notification.permission as "denied" and stays quiet.
    session.defaultSession.setPermissionCheckHandler((_page, permission) => permission !== "notifications");
    session.defaultSession.setPermissionRequestHandler((_page, permission, done) => done(permission !== "notifications"));
    open();
  });
}

function show() {
  if (!win) return open();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function open() {
  win = new BrowserWindow({
    title: "desk (Electron)",
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
// browser.
function keep(page: WebContents) {
  rightClick(page);
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
    if (key.type === "keyDown" && shortcut(page, key)) e.preventDefault();
  });
}
