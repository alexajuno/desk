// A tab's picture, live, for a chat's Browser in desk's native window (apps/native, browser.rs), from desk's headless
// Chrome, which holds Claude's tabs (chrome.ts, relay.ts), over its DevTools protocol: one connection to the tab's own
// endpoint for each Browser that shows it, which leaves what the session does there alone.
//
//     Browser ── /api/tabs/<target>/screen?w=&h=&scale= ──► desk ── ws://127.0.0.1:<port>/devtools/page/<target> ──► the tab
//             ◄── each picture, a JPEG, as one binary message ──
//
// The tab takes the half's size while a Browser shows it, as a tab in Electron took its box's until 8 Nov: the Browser
// says its size in its own pixels and the screen's scale as it opens and as it resizes, {"w": 900, "h": 1100, "scale":
// 2}, and desk lays the page out at that size and draws it at that scale (Emulation.setDeviceMetricsOverride), so the
// picture is sharp on the user's screens, at 2 and 1.5. The size is this connection's: once the Browser lets go, the
// tab goes back to its window's, 1440x900 (chrome.ts). Each picture is acknowledged once the Browser's socket took it,
// so a slow one gets fewer, not a queue.
//
// Each tab desk's Chrome makes is a window of its own (relay.ts), which draws, so its screencast sends its pictures as
// they change. A tab a page opened, a link to a new tab, comes in front of its opener's window, and the opener goes
// behind, where it draws only when asked. So four times a second desk asks the tab whether it is hidden, and a hidden
// one for a screenshot, sent on when it changed, which headless Chrome takes in about 50 ms (1 Nov). Once one has been
// still for STILL looks, it is looked at once a second, until it changes or you act on it. What the screencast sends of
// a tab behind is the wrong size, so a hidden tab's screencast pictures are dropped.
//
// The Browser sends back your mouse and keys, each a message: {"mouse": "down" | "up" | "move", "x", "y", "n", "held",
// "button": "left" | "right" | "middle"}, {"wheel": [dx, dy], "x", "y"} and {"key": "down" | "up", "k", "code", "kc",
// "text"}, each with "mods", Chrome's modifier bits; {"insert": "..."}, text pasted or written by an input method, and
// {"compose": "..."}, what the input method holds before it writes it, which the page shows underlined where you type,
// as Chrome shows it. A place or a distance is a fraction of the picture you saw, which is the tab's whole page, so desk
// turns it into the tab's own pixels by the page's size, as the tab measured it. A tab behind takes a press or a key at
// once, but answers a move or a wheel only once it draws again (1 Nov: a wheel waited until a screenshot, then
// scrolled), so one of each is on its way at a time, the next held back (the latest move, the wheels added up), and
// desk asks the tab for a screenshot after each, which also shows what it did. A press or a release sends the move held
// back first, so that a drag's selection reaches where you let go.
//
// Headless Chrome has no clipboard of the user's: {"copy": true} asks for what is selected in the page, in a text field
// or out of one, which desk tells as {"copied": "..."} for the Browser to put on yours, and Ctrl V is the Browser's
// {"insert"} of yours.
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
// A <select>'s list is drawn in the page headless (1 Nov), so it needs nothing. Chrome's own right-click menu is drawn
// nowhere, so a right click reaches only the page's own menu, where it has one.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { PORT } from "./chrome.ts";
import { HOME } from "./config.ts";
import * as db from "./db.ts";

const CHROME = `ws://127.0.0.1:${PORT}`; // desk's Chrome (chrome.ts); a second desk for testing points at another with DESK_CHROME_PORT
const EVERY = 250; // ms between looks at the tab
const STILL = 8; // looks at a tab behind that found it as it was, 2 s, after which it is looked at once a second
const WAIT = 3000; // ms an answer from the tab is waited for, after which it is let go: a dialog open in the page holds them
const PRESSED = 3000; // ms after your click or key in which a dialog or a file chooser the page opens is yours
const HELD = 2000; // ms the page may take to answer Page.enable before desk takes it for held by a box it cannot read
const UPLOADS = join(HOME, ".cache", "desk", "uploads"); // the files you gave a page, a folder each time, kept a day
const KEPT = 24 * 3600_000; // ms
const QUALITY = 80; // the pictures' JPEG quality
export const TARGET = /^[0-9A-F]{32}$/; // Chrome's id of a tab
// What a look asks the tab: whether it is hidden, and its page's size
const VIEW = "JSON.stringify([document.visibilityState, innerWidth, innerHeight])";
// What is selected in the page, in the text field you are in or out of one, for {"copy"}
const SELECTED = `(() => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number") return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection() ?? "");
})()`;
const num = (n: unknown, or = 0) => (typeof n === "number" && Number.isFinite(n) ? n : or);
const str = (s: unknown) => (typeof s === "string" ? s.slice(0, 32) : "");
// The Browser's size, in its own pixels, and the screen's scale, within what a page can be
const fit = (w: unknown, h: unknown, scale: unknown) => ({
  w: Math.round(Math.min(Math.max(num(w, 1000), 64), 4096)),
  h: Math.round(Math.min(Math.max(num(h, 1000), 64), 4096)),
  scale: Math.min(Math.max(num(scale, 1), 1), 4),
});
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a typed address may take the tab
const BUTTONS: Record<string, number> = { left: 1, right: 2, middle: 4 }; // Chrome's bits for a button held

type Said = { w?: number; h?: number; scale?: number; nav?: string; open?: string; insert?: string; compose?: string; copy?: boolean; mouse?: string; button?: string; wheel?: [number, number]; key?: string; x?: number; y?: number; n?: number; held?: boolean; mods?: number; k?: string; code?: string; kc?: number; text?: string; answer?: boolean; files?: unknown[] };
type History = { currentIndex: number; entries: { id: number }[] };
type Mouse = { type: string; x: number; y: number; button?: string; buttons?: number; modifiers: number; deltaX?: number; deltaY?: number };
type Dialog = { type: string; message: string; defaultPrompt?: string };

export async function watch(browser: WebSocket, target: string, asked: { w?: unknown; h?: unknown; scale?: unknown }) {
  if (!(await db.sql().query("select 1 from tabs where target = $1", [target])).rows.length) return browser.close(4404, "That tab is not open.");
  if (browser.readyState !== WebSocket.OPEN) return;
  const chrome = new WebSocket(`${CHROME}/devtools/page/${target}`, { maxPayload: 64 * 1024 * 1024 });
  const waiting = new Map<number, (result: unknown) => void>();
  let calls = 0, sent = "", told = "", looking = false, again = false, behind = true, still = 0, size = fit(asked.w, asked.h, asked.scale);
  let whole = { w: 0, h: 0 }; // the tab's page, in its CSS pixels, as a look measured it last
  let pressed = 0; // when you last clicked or pressed a key in the tab
  let dialog: { mine: boolean } | null = null; // the box open in the page, and whether your click or key opened it
  let chooser: number | null = null; // the file input whose chooser waits on you, by Chrome's id of its node
  let upload: { names: string[]; paths: string[]; written: Promise<unknown>[]; dir: string } | null = null; // the files you are giving it, as they come

  // A call to the tab, answered with its result, or with nothing once the tab is gone or, given a time, once it passed;
  // an answer that comes after is dropped.
  const ask = <T>(method: string, params: object = {}, ms = 0) => new Promise<T | undefined>((done) => {
    if (chrome.readyState !== WebSocket.OPEN) return done(undefined);
    const id = ++calls;
    waiting.set(id, done as (result: unknown) => void);
    chrome.send(JSON.stringify({ id, method, params }));
    if (ms) setTimeout(() => waiting.delete(id) && done(undefined), ms);
  });
  const tell = (said: object) => browser.readyState === WebSocket.OPEN && browser.send(JSON.stringify(said));
  // Whether your click or key opened what the page opens now, as the header says
  const yours = () => Date.now() - pressed < PRESSED;
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
      const shot = await ask<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: QUALITY }, WAIT);
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
  // The page at the Browser's size and scale, and its pictures at that size in the screen's pixels
  const cast = async () => {
    await ask("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: size.scale, mobile: false });
    sent = "";
    await ask("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: Math.round(size.w * size.scale), maxHeight: Math.round(size.h * size.scale) });
    soon();
  };

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
      // the one held back goes now, before what comes next
      flush: () => {
        const next = held;
        held = undefined;
        if (next) void ask("Input.dispatchMouseEvent", next);
      },
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
    const button = said.button && said.button in BUTTONS ? said.button : "left";
    if (said.mouse === "move") {
      moves.send({ type: "mouseMoved", x, y, button: said.held ? button : "none", buttons: said.held ? BUTTONS[button] : 0, modifiers });
    } else if (said.mouse === "down" || said.mouse === "up") {
      moves.flush(); // a move held back would come after the press or release, and a drag's selection would stop short of it
      const down = said.mouse === "down";
      pressed = Date.now();
      void ask("Input.dispatchMouseEvent", { type: down ? "mousePressed" : "mouseReleased", x, y, button, buttons: down ? BUTTONS[button] : 0, clickCount: Math.min(Math.max(num(said.n, 1), 1), 3), modifiers });
    } else if (Array.isArray(said.wheel)) {
      wheels.send({ type: "mouseWheel", x, y, deltaX: num(said.wheel[0]) * whole.w, deltaY: num(said.wheel[1]) * whole.h, modifiers });
    } else if (typeof said.insert === "string") {
      pressed = Date.now();
      void ask("Input.insertText", { text: said.insert.slice(0, 100_000) });
    } else if (typeof said.compose === "string") {
      const text = said.compose.slice(0, 1000), end = text.length;
      void ask("Input.imeSetComposition", { text, selectionStart: end, selectionEnd: end });
    } else if (said.key === "down" || said.key === "up") {
      const key = str(said.k), text = str(said.text), code = str(said.code), kc = num(said.kc);
      const type = said.key === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown"; // as Playwright's keyboard sends them
      pressed = Date.now();
      void ask("Input.dispatchKeyEvent", { type, key, code, text, unmodifiedText: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
    } else return;
    soon();
  };
  const copy = async () => {
    const got = await ask<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: SELECTED }, WAIT);
    const text = got?.result.value;
    if (typeof text === "string" && text) tell({ copied: text });
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
      dialog = { mine: yours() };
      tell({ dialog: { type: d.type, message: d.message, prompt: d.defaultPrompt ?? "" } });
    } else if (m.method === "Page.javascriptDialogClosed") {
      dialog = null;
      tell({ dialog: null });
      soon();
    } else if (m.method === "Page.fileChooserOpened") {
      const c = m.params as unknown as { mode: string; backendNodeId?: number }, node = c.backendNodeId;
      if (typeof node !== "number" || !yours()) return;
      chooser = node;
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
      size = fit(said.w, said.h, said.scale);
      void ask("Page.stopScreencast").then(cast);
    } else if (said.nav || said.open) void nav(said);
    else if (said.copy) void copy();
    else if (typeof said.answer === "boolean") void ask("Page.handleJavaScriptDialog", { accept: said.answer, ...(typeof said.text === "string" ? { promptText: said.text.slice(0, 100_000) } : {}) });
    else if (Array.isArray(said.files)) files(said);
    else if (whole.w) input(said);
  });
  // The tab back at its window's size, and a box your click opened cancelled, as the header says
  browser.on("close", () => {
    clearInterval(timer);
    const done = () => void ask("Emulation.clearDeviceMetricsOverride", {}, WAIT).finally(() => chrome.close());
    if (!dialog?.mine) return done();
    void ask("Page.handleJavaScriptDialog", { accept: false }, WAIT).finally(done);
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
