// A tab's picture, live, for a chat's Browser (Browser.tsx), from the agents' Chrome over its DevTools protocol: one
// connection to the tab's own endpoint for each Browser that shows it, which leaves what the session does there alone.
//
//     Browser ── /api/tabs/<target>/screen ──► desk ── ws://127.0.0.1:9333/devtools/page/<target> ──► the tab
//             ◄── each picture, a JPEG, as one binary message ──
//
// The Chrome runs headless, so the Browser is its only screen, and it goes through the proxy, which keeps the Chrome
// running while you watch, as a session's connection does. Chrome draws only the tab in front of each window, and each
// tab a session opens is in front of its own (relay.ts), so its screencast sends its pictures as they change. The
// screencast's are the size the Browser shows them at, in the screen's pixels, which it says as it opens and as it
// resizes, {"w": 1436, "h": 1476}. Each is acknowledged once the Browser's socket took it, so a slow one gets fewer, not
// a queue.
//
// A tab a page opened, a popup or a link to a new tab, comes in front of its opener's window, and the opener goes
// behind, where it draws only when asked. So four times a second desk asks the tab whether it is hidden, and a hidden
// one for a screenshot, sent on when it changed, which headless Chrome takes in about 50 ms (1 Nov). Once one has been
// still for STILL looks, it is looked at once a second, until it changes or you act on it: four whole screenshots a
// second cost the Chrome most of a core (1 Nov, windowed). Each is the whole window at the screen's scale, about 230
// kB, which the Browser shrinks itself: a screenshot cropped or scaled resizes the page while it is taken, which left a
// windowed Chrome's page shrunk for good (1 Nov). What the screencast sends of a tab behind is the wrong size (1064x586,
// 592x326), so a hidden tab's screencast pictures are dropped.
//
// The Browser sends back your mouse and keys, each a message: {"mouse": "down" | "up" | "move", "x", "y", "n", "held"},
// {"wheel": [dx, dy], "x", "y"} and {"key": "down" | "up", "k", "code", "kc", "text"}, each with "mods", Chrome's
// modifier bits, and {"insert": "..."}, text pasted or written by an input method. A place or a distance is a fraction
// of the picture you saw, which is the tab's whole window, scrollbar and all, so desk turns it into the tab's own pixels
// by the window's size, as the tab measured it (1380x815 on 1 Nov). A tab behind takes a press or a key at once, but
// answers a move or a wheel only once it draws again (1 Nov: a wheel waited until a screenshot, then scrolled), so one
// of each is on its way at a time, the next held back (the latest move, the wheels added up), and desk asks the tab for
// a screenshot after each, which also shows what it did.
//
// It also sends {"nav": "back" | "forward" | "reload"}, and {"open": "<an http or https address>"}, which Chrome's own
// history and navigation take, as its toolbar's buttons would; Claude's own calls in the tab are left as they are. desk
// tells the Browser whether the tab can go back and forward, {"back": true, "forward": false}, as a text message, when
// the socket opens and when the tab moves.
//
// What Chrome draws outside the page, which no picture holds and headless shows nowhere, desk tells the Browser to draw:
// - An alert box, a confirm, a prompt or "Leave site?" holds the page until it is answered, its pictures and every
//   answer to desk's asks with it. desk tells {"dialog": {"type": "alert" | "confirm" | "prompt" | "beforeunload",
//   "message", "prompt": "<its text at first>"}}, and {"dialog": null} once it closed, answered by you or by Claude:
//   both hear it, and the first answer closes it (1 Nov). You answer with {"answer": true | false, "text": "..."}.
//   Only a connection that heard it open can answer it, and one that joins after hears nothing and gets no answer
//   from the page, Page.enable's included; a box whose every listener left holds the page for good, until it moves (1
//   Nov: Page.navigate closed it). So a box your click opened is cancelled once you stop watching, as closing Chrome's
//   window would, and when the page has not answered Page.enable within HELD, desk tells {"held": true}, a box it
//   cannot read, which {"nav": "reload"} frees, and {"held": false} once the page answers after all, as when Claude's
//   own answer closes it, and starts the screencast again.
// - A file chooser opened by your click or key, within PRESSED of it, which desk takes from Chrome as Claude's tool
//   does: both hear it and either may give the files (1 Nov). One Claude opened is Claude's. desk tells {"chooser":
//   {"multiple": true | false}}; the Browser sends {"files": ["<name>", ...]}, then each file, a binary message, in
//   order, which desk keeps in UPLOADS and gives the page, or {"files": []} for none. desk tells {"chooser": null} as
//   it is done.
// A <select>'s list is drawn in the page headless (1 Nov), so it needs nothing.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { HOME } from "./config.ts";
import * as db from "./db.ts";

const CHROME = `ws://127.0.0.1:${process.env.DESK_CHROME_PORT || 9333}`; // through the proxy, as the header says; a second desk for testing points at another Chrome with DESK_CHROME_PORT
const EVERY = 250; // ms between looks at the tab
const STILL = 8; // looks at a tab behind that found it as it was, 2 s, after which it is looked at once a second
const WAIT = 3000; // ms an answer from the tab is waited for, after which it is let go: a dialog open in the page holds them
const PRESSED = 3000; // ms after your click or key in which a dialog or a file chooser the page opens is yours
const HELD = 2000; // ms the page may take to answer Page.enable before desk takes it for held by a box it cannot read
const UPLOADS = join(HOME, ".cache", "desk", "uploads"); // the files you gave a page, a folder each time, kept a day
const KEPT = 24 * 3600_000; // ms
export const TARGET = /^[0-9A-F]{32}$/; // Chrome's id of a tab
// What a look asks the tab: whether it is hidden, and its window's size
const VIEW = "JSON.stringify([document.visibilityState, innerWidth, innerHeight])";
const fit = (w: number, h: number) => ({ w: Math.round(Math.min(Math.max(w || 1000, 64), 4096)), h: Math.round(Math.min(Math.max(h || 1000, 64), 4096)) });
const num = (n: unknown, or = 0) => (typeof n === "number" && Number.isFinite(n) ? n : or);
const str = (s: unknown) => (typeof s === "string" ? s.slice(0, 32) : "");
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a typed address may take the tab

type Said = { w?: number; h?: number; nav?: string; open?: string; insert?: string; mouse?: string; wheel?: [number, number]; key?: string; x?: number; y?: number; n?: number; held?: boolean; mods?: number; k?: string; code?: string; kc?: number; text?: string; answer?: boolean; files?: unknown[] };
type History = { currentIndex: number; entries: { id: number }[] };
type Mouse = { type: string; x: number; y: number; button?: string; buttons?: number; modifiers: number; deltaX?: number; deltaY?: number };
type Dialog = { type: string; message: string; defaultPrompt?: string };

export async function watch(browser: WebSocket, target: string, w: number, h: number) {
  if (!(await db.sql().query("select 1 from tabs where target = $1", [target])).rows.length) return browser.close(4404, "That tab is not open.");
  if (browser.readyState !== WebSocket.OPEN) return;
  const chrome = new WebSocket(`${CHROME}/devtools/page/${target}`, { maxPayload: 64 * 1024 * 1024 });
  const waiting = new Map<number, (result: unknown) => void>();
  let asked = 0, sent = "", told = "", looking = false, again = false, behind = true, still = 0, size = fit(w, h);
  let whole = { w: 0, h: 0 }; // the tab's window, in its CSS pixels, as a look measured it last
  let pressed = 0; // when you last clicked or pressed a key in the tab
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
  const show = (jpeg: string, then?: () => void) => {
    if (jpeg === sent || browser.readyState !== WebSocket.OPEN) return then?.();
    sent = jpeg;
    browser.send(Buffer.from(jpeg, "base64"), { binary: true }, () => then?.());
  };
  const look = async () => {
    if (looking) return;
    looking = true;
    const view = await ask<{ result: { value?: string } }>("Runtime.evaluate", { expression: VIEW }, WAIT);
    if (view) {
      const [hidden, width, height] = JSON.parse(view.result.value ?? "[]") as [string, number, number];
      behind = hidden === "hidden";
      if (width && height) whole = { w: width, h: height };
    }
    if (behind) {
      const shot = await ask<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 50 }, WAIT); // whole, as the header says
      still = shot?.data === sent ? still + 1 : 0;
      if (shot) show(shot.data);
    }
    looking = false;
    if (again) {
      again = false;
      void look();
    }
  };
  // a look right after your input to a hidden tab, which lands it and shows what it did
  const soon = () => {
    if (!behind) return;
    still = 0;
    if (looking) again = true;
    else void look();
  };
  let ticks = 0;
  const timer = setInterval(() => (still < STILL || ++ticks % 4 === 0) && void look(), EVERY);
  const cast = () => ask("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: size.w, maxHeight: size.h });

  // One move or one wheel on its way at a time, as the header says: the next held back, merged into the one held.
  const lane = (merge: (held: Mouse, next: Mouse) => Mouse) => {
    let out = false, held: Mouse | undefined;
    const go = (event: Mouse) => {
      out = true;
      void ask("Input.dispatchMouseEvent", event).then(() => {
        out = false;
        const next = held;
        held = undefined;
        if (next) go(next);
      });
    };
    return {
      send: (event: Mouse) => (out ? (held = held ? merge(held, event) : event) : go(event)),
      drop: () => { held = undefined; },
    };
  };
  const moves = lane((_, next) => next);
  const wheels = lane((held, next) => ({ ...next, deltaX: num(held.deltaX) + num(next.deltaX), deltaY: num(held.deltaY) + num(next.deltaY) }));

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
    soon();
  };

  const input = (said: Said) => {
    const x = num(said.x) * whole.w, y = num(said.y) * whole.h, modifiers = num(said.mods) & 15;
    if (said.mouse === "move") {
      moves.send({ type: "mouseMoved", x, y, button: said.held ? "left" : "none", buttons: said.held ? 1 : 0, modifiers });
    } else if (said.mouse === "down" || said.mouse === "up") {
      moves.drop(); // a press or a release says where it is itself, and a move held back would come after it
      const down = said.mouse === "down";
      pressed = Date.now();
      void ask("Input.dispatchMouseEvent", { type: down ? "mousePressed" : "mouseReleased", x, y, button: "left", buttons: down ? 1 : 0, clickCount: Math.min(Math.max(num(said.n, 1), 1), 3), modifiers });
    } else if (Array.isArray(said.wheel)) {
      wheels.send({ type: "mouseWheel", x, y, deltaX: num(said.wheel[0]) * whole.w, deltaY: num(said.wheel[1]) * whole.h, modifiers });
    } else if (typeof said.insert === "string") {
      void ask("Input.insertText", { text: said.insert.slice(0, 100_000) });
    } else if (said.key === "down" || said.key === "up") {
      const key = str(said.k), text = str(said.text), code = str(said.code), kc = num(said.kc);
      const type = said.key === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown"; // as Playwright's keyboard sends them
      pressed = Date.now();
      void ask("Input.dispatchKeyEvent", { type, key, code, text, unmodifiedText: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
    } else return;
    soon();
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
    soon();
  };

  chrome.on("open", () => {
    void cast();
    void look();
    let enabled = false, held = false;
    const late = setTimeout(() => !enabled && (held = true) && tell({ held: true }), HELD);
    void ask("Page.enable").then(() => { // for the tab's moves and its dialogs, below
      enabled = true;
      clearTimeout(late);
      if (held) { // the screencast asked for meanwhile never started (1 Nov)
        tell({ held: false });
        sent = "";
        void ask("Page.stopScreencast").then(cast);
      }
      void moved();
    });
    void ask("Page.setInterceptFileChooserDialog", { enabled: true });
  });
  chrome.on("message", (data: Buffer) => {
    const m = JSON.parse(String(data)) as { id?: number; result?: unknown; method?: string; params?: { data: string; sessionId: number; frame?: { parentId?: string } } };
    if (m.id) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
    } else if (m.method === "Page.screencastFrame" && m.params) {
      const frame = m.params.sessionId, ack = () => void ask("Page.screencastFrameAck", { sessionId: frame });
      if (behind) ack();
      else show(m.params.data, ack);
    } else if ((m.method === "Page.frameNavigated" && !m.params?.frame?.parentId) || m.method === "Page.navigatedWithinDocument") void moved();
    else if (m.method === "Page.javascriptDialogOpening") {
      const d = m.params as unknown as Dialog;
      dialog = { mine: Date.now() - pressed < PRESSED };
      tell({ dialog: { type: d.type, message: d.message, prompt: d.defaultPrompt ?? "" } });
    } else if (m.method === "Page.javascriptDialogClosed") {
      dialog = null;
      tell({ dialog: null });
      soon();
    } else if (m.method === "Page.fileChooserOpened" && Date.now() - pressed < PRESSED) {
      const c = m.params as unknown as { mode: string; backendNodeId?: number };
      if (typeof c.backendNodeId !== "number") return;
      chooser = c.backendNodeId;
      upload = null;
      tell({ chooser: { multiple: c.mode === "selectMultiple" } });
    }
  });
  chrome.on("error", () => {}); // it closes next
  chrome.on("close", () => {
    clearInterval(timer);
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
    if (said.w && said.h) {
      size = fit(said.w, said.h);
      sent = "";
      void ask("Page.stopScreencast").then(cast);
    } else if (said.nav || said.open) void nav(said);
    else if (typeof said.answer === "boolean") void ask("Page.handleJavaScriptDialog", { accept: said.answer, ...(typeof said.text === "string" ? { promptText: said.text.slice(0, 100_000) } : {}) });
    else if (Array.isArray(said.files)) files(said);
    else if (whole.w) input(said);
  });
  browser.on("close", () => {
    clearInterval(timer);
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
