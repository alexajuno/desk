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
// for a screenshot, sent on when it changed. It is the whole window at the screen's scale, about 230 kB, which the
// Browser shrinks itself: a screenshot cropped or scaled resizes the page while it is taken, and two at once, desk's or
// Claude's own, leave it shrunk for good (1 Nov: 1380x815 to 9x6, and clearing its emulation did not put it back),
// while whole ones at once left it alone. What the screencast sends while a screenshot wakes the tab is the wrong size
// (1064x586, 592x326), so a hidden tab's screencast pictures are dropped.
//
// The Browser sends back your mouse and keys, each a message: {"mouse": "down" | "up" | "move", "x", "y", "n", "held"},
// {"wheel": [dx, dy], "x", "y"} and {"key": "down" | "up", "k", "code", "kc", "text"}, each with "mods", Chrome's
// modifier bits, and {"insert": "..."}, text pasted or written by an input method. A place or a distance is a fraction
// of the picture you saw, which is the tab's whole window, scrollbar and all, so desk turns it into the tab's own pixels
// by the window's size, as the tab measured it (1380x815 on 1 Nov). A tab behind takes a press or a key at once, but
// answers a move or a wheel only once it draws again (1 Nov: a wheel waited until a screenshot, then scrolled), so one
// of each is on its way at a time, the next held back (the latest move, the wheels added up), and desk asks the tab for
// a screenshot after each, which also shows what it did.
import { WebSocket } from "ws";
import * as db from "./db.ts";

const CHROME = "ws://127.0.0.1:9334"; // the Chrome itself, as the relay's watcher reaches it (relay.ts): watching keeps it up no longer than a session does
const EVERY = 250; // ms between looks at the tab
export const TARGET = /^[0-9A-F]{32}$/; // Chrome's id of a tab
// What a look asks the tab: whether it is hidden, and its window's size
const VIEW = "JSON.stringify([document.visibilityState, innerWidth, innerHeight])";
const fit = (w: number, h: number) => ({ w: Math.round(Math.min(Math.max(w || 1000, 64), 4096)), h: Math.round(Math.min(Math.max(h || 1000, 64), 4096)) });
const num = (n: unknown, or = 0) => (typeof n === "number" && Number.isFinite(n) ? n : or);
const str = (s: unknown) => (typeof s === "string" ? s.slice(0, 32) : "");

type Said = { w?: number; h?: number; insert?: string; mouse?: string; wheel?: [number, number]; key?: string; x?: number; y?: number; n?: number; held?: boolean; mods?: number; k?: string; code?: string; kc?: number; text?: string };
type Mouse = { type: string; x: number; y: number; button?: string; buttons?: number; modifiers: number; deltaX?: number; deltaY?: number };

export async function watch(browser: WebSocket, target: string, w: number, h: number) {
  if (!(await db.sql().query("select 1 from tabs where target = $1", [target])).rows.length) return browser.close(4404, "That tab is not open.");
  if (browser.readyState !== WebSocket.OPEN) return;
  const chrome = new WebSocket(`${CHROME}/devtools/page/${target}`, { maxPayload: 64 * 1024 * 1024 });
  const waiting = new Map<number, (result: unknown) => void>();
  let asked = 0, sent = "", looking = false, again = false, behind = true, size = fit(w, h);
  let whole = { w: 0, h: 0 }; // the tab's window, in its CSS pixels, as a look measured it last

  // A call to the tab, answered with its result, or with nothing once the tab is gone.
  const ask = <T>(method: string, params: object = {}) => new Promise<T | undefined>((done) => {
    if (chrome.readyState !== WebSocket.OPEN) return done(undefined);
    waiting.set(++asked, done as (result: unknown) => void);
    chrome.send(JSON.stringify({ id: asked, method, params }));
  });
  const show = (jpeg: string, then?: () => void) => {
    if (jpeg === sent || browser.readyState !== WebSocket.OPEN) return then?.();
    sent = jpeg;
    browser.send(Buffer.from(jpeg, "base64"), { binary: true }, () => then?.());
  };
  const look = async () => {
    if (looking) return;
    looking = true;
    const view = await ask<{ result: { value?: string } }>("Runtime.evaluate", { expression: VIEW });
    const [hidden, width, height] = JSON.parse(view?.result.value ?? "[]") as [string, number, number];
    behind = hidden === "hidden";
    if (width && height) whole = { w: width, h: height };
    if (behind) {
      const shot = await ask<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 50 }); // whole, as the header says
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
    if (looking) again = true;
    else void look();
  };
  const timer = setInterval(() => void look(), EVERY);
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
  });
  chrome.on("message", (data: Buffer) => {
    const m = JSON.parse(String(data)) as { id?: number; result?: unknown; method?: string; params?: { data: string; sessionId: number } };
    if (m.id) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
    } else if (m.method === "Page.screencastFrame" && m.params) {
      const frame = m.params.sessionId, ack = () => void ask("Page.screencastFrameAck", { sessionId: frame });
      if (behind) ack();
      else show(m.params.data, ack);
    }
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
    } else if (whole.w) input(said);
  });
  browser.on("close", () => {
    clearInterval(timer);
    chrome.close();
  });
}
