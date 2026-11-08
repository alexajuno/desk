// What Chrome draws outside a tab's page, for a chat's Browser in desk's app (Browser.tsx), which shows the tab itself
// (apps/desktop/src/tabs.ts), over the tab's DevTools protocol: one connection to the tab's own endpoint for each
// Browser that shows it, which leaves what the session does there alone.
//
//     Browser ── /api/tabs/<target>/screen ──► desk ── ws://127.0.0.1:9337/devtools/page/<target> ──► the tab
//             ◄── what the tab can do and what its page asks, as text ──
//
// Until 2 Nov it also sent desk in a web page pictures of the tab, live, and took your mouse and keys there for it. desk
// in a web page has no Browser since ("likely we’ll just abandon chrome in web app", the user, 1 Nov), and in the app
// the tab takes your mouse and keys itself.
//
// The Browser sends {"nav": "back" | "forward" | "reload"}, and {"open": "<an http or https address>"}, which Chrome's
// own history and navigation take, as its toolbar's buttons would; Claude's own calls in the tab are left as they are.
// desk tells the Browser whether the tab can go back and forward, {"back": true, "forward": false}, as a text message,
// when the socket opens and when the tab moves.
//
// What Chrome draws outside the page, which the app's view of the tab shows nowhere, desk tells the Browser to draw:
// - An alert box, a confirm, a prompt or "Leave site?" holds the page until it is answered, every answer to desk's asks
//   with it. desk tells {"dialog": {"type": "alert" | "confirm" | "prompt" | "beforeunload", "message", "prompt": "<its
//   text at first>"}}, and {"dialog": null} once it closed, answered by you or by Claude: both hear it, and the first
//   answer closes it (1 Nov). You answer with {"answer": true | false, "text": "..."}. Only a connection that heard it
//   open can answer it, and one that joins after hears nothing and gets no answer from the page, Page.enable's
//   included; a box whose every listener left holds the page for good, until it moves (1 Nov: Page.navigate closed
//   it). So a box your click opened is cancelled once you stop watching, as closing Chrome's window would, and when
//   the page has not answered Page.enable within HELD, desk tells {"held": true}, a box it cannot read, which {"nav":
//   "reload"} frees, and {"held": false} once the page answers after all, as when Claude's own answer closes it.
// - A file chooser opened by your click or key, which desk takes from Chrome as Claude's tool does: both hear it and
//   either may give the files (1 Nov). desk hears nothing of your clicks in the tab, so a box or a chooser is yours when
//   the app says your keys are in the tab; one Claude opened is Claude's. desk tells {"chooser": {"multiple": true |
//   false}}; the Browser sends {"files": ["<name>", ...]}, then each file, a binary message, in order, which desk keeps
//   in UPLOADS and gives the page, or {"files": []} for none. desk tells {"chooser": null} as it is done.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { HOME } from "./config.ts";
import * as db from "./db.ts";
import { PORT } from "./chrome.ts";

const CHROME = `ws://127.0.0.1:${PORT}`; // desk's Chrome (chrome.ts); a second desk for testing points at another with DESK_CHROME_PORT
const YOURS = 10_000; // ms after your last click or key in the tab in which what the page opens is yours
const WAIT = 3000; // ms an answer from the tab is waited for, after which it is let go: a dialog open in the page holds them
const HELD = 2000; // ms the page may take to answer Page.enable before desk takes it for held by a box it cannot read
const UPLOADS = join(HOME, ".cache", "desk", "uploads"); // the files you gave a page, a folder each time, kept a day
const KEPT = 24 * 3600_000; // ms
export const TARGET = /^[0-9A-F]{32}$/; // Chrome's id of a tab
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a typed address may take the tab

type Said = { nav?: string; open?: string; answer?: boolean; text?: string; files?: unknown[] };
type History = { currentIndex: number; entries: { id: number }[] };
type Dialog = { type: string; message: string; defaultPrompt?: string };

export async function watch(browser: WebSocket, target: string) {
  if (!(await db.sql().query("select 1 from tabs where target = $1", [target])).rows.length) return browser.close(4404, "That tab is not open.");
  if (browser.readyState !== WebSocket.OPEN) return;
  const chrome = new WebSocket(`${CHROME}/devtools/page/${target}`);
  const waiting = new Map<number, (result: unknown) => void>();
  let asked = 0, told = "";
  let dialog: { mine: boolean } | null = null; // the box open in the page, and whether your click or key opened it
  let chooser: number | null = null; // the file input whose chooser waits on you, by Chrome's id of its node
  let upload: { names: string[]; paths: string[]; written: Promise<unknown>[]; dir: string } | null = null; // the files you are giving it, as they come

  // A call to the tab, answered with its result, or with nothing once the tab is gone or, given a time, once it passed;
  // an answer that comes after is dropped.
  const ask = <T>(method: string, params: object = {}, ms = 0) => new Promise<T | undefined>((done) => {
    if (chrome.readyState !== WebSocket.OPEN) return done(undefined);
    const id = ++asked;
    waiting.set(id, done as (result: unknown) => void);
    chrome.send(JSON.stringify({ id, method, params }));
    if (ms) setTimeout(() => waiting.delete(id) && done(undefined), ms);
  });
  const tell = (said: object) => browser.readyState === WebSocket.OPEN && browser.send(JSON.stringify(said));
  let touched = 0; // when your last click or key reached the tab
  // Whether what the page opens now is yours: you clicked or typed in the tab just before (the header says why)
  const yours = async () => Date.now() - touched < YOURS;

  // Whether the tab can go back and forward, told the Browser when it changed.
  const moved = async () => {
    const h = await ask<History>("Page.getNavigationHistory");
    const now = h && JSON.stringify({ back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1 });
    if (!now || now === told || browser.readyState !== WebSocket.OPEN) return;
    told = now;
    browser.send(now);
  };
  const nav = async (said: Said) => {
    if (said.nav === "reload") await ask("Page.reload");
    else if (said.nav === "back" || said.nav === "forward") {
      const h = await ask<History>("Page.getNavigationHistory");
      const entry = h?.entries[h.currentIndex + (said.nav === "back" ? -1 : 1)];
      if (entry) await ask("Page.navigateToHistoryEntry", { entryId: entry.id });
    } else if (typeof said.open === "string" && said.open.length <= 8192 && ADDRESS.test(said.open)) await ask("Page.navigate", { url: said.open });
  };

  // The files you chose for the chooser, as the header says: their names, then each file, which may come before the
  // folder for them is made, and each written as it comes; the page gets them once the last is written.
  const files = (said: Said) => {
    const names = (said.files ?? []).map((n) => basename(String(n)).replace(/\0/g, "").slice(0, 200) || "file");
    if (chooser === null || !names.length) {
      chooser = upload = null;
      return tell({ chooser: null });
    }
    void sweep();
    const dir = join(UPLOADS, randomUUID());
    upload = { names, paths: [], written: [mkdir(dir, { recursive: true })], dir };
  };
  const file = async (data: Buffer) => {
    const u = upload, node = chooser;
    if (!u || node === null || u.paths.length >= u.names.length) return;
    // two files of one name each keep theirs, the second in a folder of its own
    const i = u.paths.length, name = u.names[i], path = u.names.indexOf(name) < i ? join(u.dir, String(i), name) : join(u.dir, name);
    u.paths.push(path);
    const made = u.written[0];
    u.written.push(made.then(() => mkdir(join(path, ".."), { recursive: true })).then(() => writeFile(path, data)));
    if (u.paths.length < u.names.length) return;
    await Promise.all(u.written);
    if (upload !== u) return;
    await ask("DOM.setFileInputFiles", { files: u.paths, backendNodeId: node });
    chooser = upload = null;
    tell({ chooser: null });
  };

  chrome.on("open", () => {
    let enabled = false, held = false;
    const late = setTimeout(() => !enabled && (held = true) && tell({ held: true }), HELD);
    void ask("Page.enable").then(() => { // for the tab's moves and its dialogs, below
      enabled = true;
      clearTimeout(late);
      if (held) tell({ held: false });
      void moved();
    });
    void ask("Page.setInterceptFileChooserDialog", { enabled: true });
  });
  chrome.on("message", (data: Buffer) => {
    const m = JSON.parse(String(data)) as { id?: number; result?: unknown; method?: string; params?: { frame?: { parentId?: string } } };
    if (m.id) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
    } else if ((m.method === "Page.frameNavigated" && !m.params?.frame?.parentId) || m.method === "Page.navigatedWithinDocument") void moved();
    else if (m.method === "Page.javascriptDialogOpening") {
      const d = m.params as unknown as Dialog, opened: { mine: boolean } = dialog = { mine: false };
      void yours().then((mine) => { opened.mine = mine; });
      tell({ dialog: { type: d.type, message: d.message, prompt: d.defaultPrompt ?? "" } });
    } else if (m.method === "Page.javascriptDialogClosed") {
      dialog = null;
      tell({ dialog: null });
    } else if (m.method === "Page.fileChooserOpened") {
      const c = m.params as unknown as { mode: string; backendNodeId?: number }, node = c.backendNodeId;
      if (typeof node !== "number") return;
      void yours().then((mine) => {
        if (!mine) return;
        chooser = node;
        upload = null;
        tell({ chooser: { multiple: c.mode === "selectMultiple" } });
      });
    }
  });
  chrome.on("error", () => {}); // it closes next
  chrome.on("close", () => {
    for (const done of waiting.values()) done(undefined);
    if (browser.readyState === WebSocket.OPEN) browser.close(4404, "The tab closed.");
  });
  browser.on("message", (data: RawData, binary: boolean) => {
    if (binary) return void file(Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])).catch(() => tell({ chooser: null }));
    let said: Said;
    try {
      said = JSON.parse(String(data)) as Said;
    } catch {
      return;
    }
    if (!said || typeof said !== "object") return;
    if (said.nav || said.open) void nav(said);
    else if (typeof said.answer === "boolean") void ask("Page.handleJavaScriptDialog", { accept: said.answer, ...(typeof said.text === "string" ? { promptText: said.text.slice(0, 100_000) } : {}) });
    else if (Array.isArray(said.files)) files(said);
  });
  browser.on("close", () => {
    if (!dialog?.mine) return chrome.close();
    void ask("Page.handleJavaScriptDialog", { accept: false }, WAIT).finally(() => chrome.close()); // as the header says
  });
}

// The folders of files given a page more than KEPT ago: a page reads a file when it uploads it, which may be a while
// after it was chosen.
async function sweep() {
  for (const name of await readdir(UPLOADS).catch(() => [] as string[])) {
    const dir = join(UPLOADS, name);
    const at = (await stat(dir).catch(() => null))?.mtimeMs;
    if (at !== undefined && Date.now() - at > KEPT) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
