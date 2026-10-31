// A tab's picture, live, for a chat's Browser (Browser.tsx), from the agents' Chrome over its DevTools protocol: one
// connection to the tab's own endpoint for each Browser that shows it, which leaves what the session does there alone.
//
//     Browser ── /api/tabs/<target>/screen ──► desk ── ws://127.0.0.1:9334/devtools/page/<target> ──► the tab
//             ◄── each picture, a JPEG, as one binary message ──
//
// Chrome draws only the tab in front of its window, so its screencast sends that one's pictures as they change, and none
// of a tab behind it (1 Nov: 45 in 3 s in front, 0 behind). The screencast's are the size the Browser shows them at, in
// the screen's pixels, which it says as it opens and as it resizes, {"w": 1436, "h": 1476}: Chrome draws at the screen's
// scale, so a tab 1365 wide came at 2760 (1 Nov). Each is acknowledged once the Browser's socket took it, so a slow one
// gets fewer, not a queue.
//
// Chrome draws a tab behind when asked, so four times a second desk asks the tab whether it is hidden, and a hidden one
// for a screenshot, sent on when it changed. Once one has been still for STILL looks, it is looked at once a second,
// until it changes or you act on it: four whole screenshots a second cost the agents' Chrome most of a core (1 Nov).
// And Chrome draws one only while its window draws, which a still tab in front stops, so desk keeps the tab in front
// drawing meanwhile (keepDrawing, below), and gives up on a screenshot that takes longer than WAIT. Each is the whole
// window at the screen's scale, about 230 kB, which the Browser shrinks itself: a screenshot cropped or scaled resizes
// the page while it is taken, and two at once, desk's or Claude's own, leave it shrunk for good (1 Nov: 1380x815 to
// 9x6, and clearing its emulation did not put it back), while whole ones at once left it alone. What the screencast
// sends while a screenshot wakes the tab is the wrong size (1064x586, 592x326), so a hidden tab's screencast pictures
// are dropped.
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
import { WebSocket } from "ws";
import * as db from "./db.ts";

const CHROME = "ws://127.0.0.1:9334"; // the Chrome itself, as the relay's watcher reaches it (relay.ts): watching keeps it up no longer than a session does
const EVERY = 250; // ms between looks at the tab
const STILL = 8; // looks at a tab behind that found it as it was, 2 s, after which it is looked at once a second
const WAIT = 3000; // ms an answer from the tab is waited for, after which it is let go: a dialog open in the page holds them
export const TARGET = /^[0-9A-F]{32}$/; // Chrome's id of a tab
// What a look asks the tab: whether it is hidden, and its window's size
const VIEW = "JSON.stringify([document.visibilityState, innerWidth, innerHeight])";
const fit = (w: number, h: number) => ({ w: Math.round(Math.min(Math.max(w || 1000, 64), 4096)), h: Math.round(Math.min(Math.max(h || 1000, 64), 4096)) });
const num = (n: unknown, or = 0) => (typeof n === "number" && Number.isFinite(n) ? n : or);
const str = (s: unknown) => (typeof s === "string" ? s.slice(0, 32) : "");
const ADDRESS = /^(https?:\/\/\S+|about:blank)$/i; // where a typed address may take the tab

type Said = { w?: number; h?: number; nav?: string; open?: string; insert?: string; mouse?: string; wheel?: [number, number]; key?: string; x?: number; y?: number; n?: number; held?: boolean; mods?: number; k?: string; code?: string; kc?: number; text?: string };
type History = { currentIndex: number; entries: { id: number }[] };
type Mouse = { type: string; x: number; y: number; button?: string; buttons?: number; modifiers: number; deltaX?: number; deltaY?: number };

export async function watch(browser: WebSocket, target: string, w: number, h: number) {
  if (!(await db.sql().query("select 1 from tabs where target = $1", [target])).rows.length) return browser.close(4404, "That tab is not open.");
  if (browser.readyState !== WebSocket.OPEN) return;
  const chrome = new WebSocket(`${CHROME}/devtools/page/${target}`, { maxPayload: 64 * 1024 * 1024 });
  const waiting = new Map<number, (result: unknown) => void>();
  let asked = 0, sent = "", told = "", looking = false, again = false, behind = true, still = 0, size = fit(w, h);
  let whole = { w: 0, h: 0 }; // the tab's window, in its CSS pixels, as a look measured it last

  // A call to the tab, answered with its result, or with nothing once the tab is gone or, given a time, once it passed;
  // an answer that comes after is dropped.
  const ask = <T>(method: string, params: object = {}, ms = 0) => new Promise<T | undefined>((done) => {
    if (chrome.readyState !== WebSocket.OPEN) return done(undefined);
    const id = ++asked;
    waiting.set(id, done as (result: unknown) => void);
    chrome.send(JSON.stringify({ id, method, params }));
    if (ms) setTimeout(() => waiting.delete(id) && done(undefined), ms);
  });
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
      wake(browser, behind);
      if (width && height) whole = { w: width, h: height };
    }
    if (behind) {
      drawing++;
      const shot = await ask<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 50 }, WAIT); // whole, as the header says
      drawing--;
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
      void ask("Input.dispatchMouseEvent", { type: down ? "mousePressed" : "mouseReleased", x, y, button: "left", buttons: down ? 1 : 0, clickCount: Math.min(Math.max(num(said.n, 1), 1), 3), modifiers });
    } else if (Array.isArray(said.wheel)) {
      wheels.send({ type: "mouseWheel", x, y, deltaX: num(said.wheel[0]) * whole.w, deltaY: num(said.wheel[1]) * whole.h, modifiers });
    } else if (typeof said.insert === "string") {
      void ask("Input.insertText", { text: said.insert.slice(0, 100_000) });
    } else if (said.key === "down" || said.key === "up") {
      const key = str(said.k), text = str(said.text), code = str(said.code), kc = num(said.kc);
      const type = said.key === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown"; // as Playwright's keyboard sends them
      void ask("Input.dispatchKeyEvent", { type, key, code, text, unmodifiedText: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers });
    } else return;
    soon();
  };

  chrome.on("open", () => {
    void cast();
    void look();
    void ask("Page.enable").then(moved); // for the tab's moves, below
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
  });
  chrome.on("error", () => {}); // it closes next
  chrome.on("close", () => {
    clearInterval(timer);
    for (const done of waiting.values()) done(undefined);
    if (browser.readyState === WebSocket.OPEN) browser.close(4404, "The tab closed.");
  });
  browser.on("message", (data: Buffer) => {
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
    else if (whole.w) input(said);
  });
  browser.on("close", () => {
    clearInterval(timer);
    wake(browser, false);
    chrome.close();
  });
}

// The tab in front of the window, kept drawing while a Browser shows a tab behind it. Chrome draws a tab behind only
// while its window draws, and the window draws only while the tab in front changes: behind a still one, a screenshot
// took 1 to 3 s, and some never came (1 Nov), though the agents' Chrome runs with its backgrounding off. A highlight
// with nothing in it, shown and hidden on the tab in front every frame, keeps the window drawing, which brought them to
// 0.1 to 0.5 s; it is drawn over the page, not in it, so neither the page nor Claude's calls see it. A screencast of the
// tab in front draws nothing new, and bringing the watched tab to the front would take it from Claude's.
//
// One connection to the Chrome attaches to each tab and asks every second which are in front, one a window, while a
// Browser shows a tab behind, and the highlight is drawn only while a screenshot of one is on its way.
const FRAME = 16; // ms between the highlight's shows and hides, a frame at 60 Hz
const NOTHING = { x: 0, y: 0, width: 1, height: 1, color: { r: 0, g: 0, b: 0, a: 0 } };
const showing = new Set<WebSocket>(); // the Browsers showing a tab behind
let drawing = 0; // their screenshots on their way
let waker: { stop: () => void } | undefined;

function wake(browser: WebSocket, behind: boolean) {
  if (behind) showing.add(browser);
  else showing.delete(browser);
  if (showing.size && !waker) waker = keepDrawing();
  else if (!showing.size && waker) {
    waker.stop();
    waker = undefined;
  }
}

function keepDrawing() {
  let chrome: WebSocket | undefined, asked = 0, on = false, busy = false, stopped = false;
  const tabs = new Map<string, { session: string; front: boolean; ready: boolean }>(); // by target
  const waiting = new Map<number, (result: unknown) => void>();
  const ask = <T>(method: string, params: object = {}, sessionId?: string) => new Promise<T | undefined>((done) => {
    if (chrome?.readyState !== WebSocket.OPEN) return done(undefined);
    const id = ++asked;
    waiting.set(id, done as (result: unknown) => void);
    chrome.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => waiting.delete(id) && done(undefined), WAIT);
  });
  const connect = async () => {
    const res = await fetch(`${CHROME.replace("ws", "http")}/json/version`, { signal: AbortSignal.timeout(WAIT) }).catch(() => undefined);
    const url = res?.ok ? ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl : undefined;
    if (!url || stopped) return;
    const ws = chrome = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    ws.on("message", (data: Buffer) => {
      const m = JSON.parse(String(data)) as { id?: number; result?: unknown };
      if (!m.id) return;
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
    });
    ws.on("error", () => {}); // it closes next
    ws.on("close", () => {
      if (chrome === ws) chrome = undefined;
      tabs.clear();
      for (const done of waiting.values()) done(undefined);
      waiting.clear();
    });
    await new Promise((done) => ws.once("open", done).once("close", done));
  };
  // which tabs are in front, each made ready for the highlight once it is
  const find = async () => {
    const all = await ask<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    if (!all) return;
    const pages = all.targetInfos.filter((t) => t.type === "page").map((t) => t.targetId);
    for (const target of tabs.keys()) if (!pages.includes(target)) tabs.delete(target);
    await Promise.all(pages.map(async (target) => {
      let tab = tabs.get(target);
      if (!tab) {
        const got = await ask<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true });
        if (!got) return;
        tabs.set(target, (tab = { session: got.sessionId, front: false, ready: false }));
      }
      const seen = await ask<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.visibilityState" }, tab.session);
      tab.front = seen?.result.value === "visible";
      if (tab.front && !tab.ready) tab.ready = Boolean((await ask("DOM.enable", {}, tab.session)) && (await ask("Overlay.enable", {}, tab.session)));
    }));
  };
  const tick = () => {
    if (busy) return;
    busy = true;
    void (chrome ? find() : connect().then(find)).finally(() => { busy = false; });
  };
  const second = setInterval(tick, 1000);
  tick();
  const frame = setInterval(() => {
    if (!drawing) return;
    on = !on;
    for (const tab of tabs.values()) {
      if (!tab.front || !tab.ready || chrome?.readyState !== WebSocket.OPEN) continue;
      chrome.send(JSON.stringify({ id: ++asked, sessionId: tab.session, method: on ? "Overlay.highlightRect" : "Overlay.hideHighlight", params: on ? NOTHING : {} }));
    }
  }, FRAME);
  return {
    // closing the connection lets go of each tab, and its highlight with it
    stop: () => {
      stopped = true;
      clearInterval(second);
      clearInterval(frame);
      chrome?.close();
    },
  };
}
