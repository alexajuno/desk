// A tab's picture, live, for a chat's Browser (Browser.tsx), from the agents' Chrome over its DevTools protocol: one
// connection to the tab's own endpoint for each Browser that shows it, which leaves what the session does there alone.
//
//     Browser ── /api/tabs/<target>/screen ──► desk ── ws://127.0.0.1:9334/devtools/page/<target> ──► the tab
//             ◄── each picture, a JPEG, as one binary message ──
//
// Chrome draws only the tab in front of its window, so its screencast sends that one's pictures as they change, and none
// of a tab behind it (1 Nov: 45 in 3 s in front, 0 behind). It draws a tab behind when asked, in about 0.1 s, so while
// the screencast is quiet desk asks the tab whether it is hidden, and four times a second asks a hidden one for its
// picture, sent on when it changed; one wakes its drawing for a moment, whose pictures the screencast sends too. Each
// picture is the size the Browser shows it at, in the screen's pixels, which it says as it opens and as it resizes,
// {"w": 1436, "h": 1476}: Chrome draws at the screen's scale, so a tab 1365 wide came at 2760 (1 Nov). Each screencast
// picture is acknowledged once the Browser's socket took it, so a slow one gets fewer, not a queue.
import { WebSocket } from "ws";
import * as db from "./db.ts";

const CHROME = "ws://127.0.0.1:9334"; // the Chrome itself, as the relay's watcher reaches it (relay.ts): watching keeps it up no longer than a session does
const EVERY = 250; // ms between looks at a tab whose screencast is quiet
const QUIET = 500; // ms with no screencast picture before desk looks
export const TARGET = /^[0-9A-F]{32}$/; // Chrome's id of a tab
// What a look asks the tab: whether it is hidden, and where its viewport is, for a picture of only that
const VIEW = "JSON.stringify([document.visibilityState, visualViewport.pageLeft, visualViewport.pageTop, visualViewport.width, visualViewport.height, devicePixelRatio])";
const fit = (w: number, h: number) => ({ w: Math.round(Math.min(Math.max(w || 1000, 64), 4096)), h: Math.round(Math.min(Math.max(h || 1000, 64), 4096)) });

export async function watch(browser: WebSocket, target: string, w: number, h: number) {
  if (!(await db.sql().query("select 1 from tabs where target = $1", [target])).rows.length) return browser.close(4404, "That tab is not open.");
  if (browser.readyState !== WebSocket.OPEN) return;
  const chrome = new WebSocket(`${CHROME}/devtools/page/${target}`, { maxPayload: 64 * 1024 * 1024 });
  const waiting = new Map<number, (result: unknown) => void>();
  let asked = 0, last = 0, sent = "", looking = false, size = fit(w, h);

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
    if (looking || Date.now() - last < QUIET) return;
    looking = true;
    const seen = await ask<{ result: { value?: string } }>("Runtime.evaluate", { expression: VIEW });
    const [hidden, x, y, width, height, ratio] = JSON.parse(seen?.result.value ?? "[]") as [string, number, number, number, number, number];
    if (hidden === "hidden" && width && height) {
      const scale = Math.min(1, size.w / (width * ratio), size.h / (height * ratio));
      const shot = await ask<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x, y, width, height, scale } });
      if (shot) show(shot.data);
    }
    looking = false;
  };
  const timer = setInterval(() => void look(), EVERY);
  const cast = () => ask("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: size.w, maxHeight: size.h });

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
      last = Date.now();
      const frame = m.params.sessionId;
      show(m.params.data, () => void ask("Page.screencastFrameAck", { sessionId: frame }));
    }
  });
  chrome.on("error", () => {}); // it closes next
  chrome.on("close", () => {
    clearInterval(timer);
    for (const done of waiting.values()) done(undefined);
    if (browser.readyState === WebSocket.OPEN) browser.close(4404, "The tab closed.");
  });
  browser.on("message", (data: Buffer) => {
    let said: { w?: number; h?: number };
    try {
      said = JSON.parse(String(data)) as typeof said;
    } catch {
      return;
    }
    if (!said?.w || !said.h) return;
    size = fit(said.w, said.h);
    sent = "";
    void ask("Page.stopScreencast").then(cast);
  });
  browser.on("close", () => {
    clearInterval(timer);
    chrome.close();
  });
}
