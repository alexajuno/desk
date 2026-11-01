// The browser relay, which every desk session's chrome MCP reaches Claude's tabs through, so that desk knows which
// session opened each tab and can show a chat its own ("i can view tabs per sessions directly on what it's doing", the
// user, 31 Oct). It runs in the session host (host.ts), which outlives desk's restarts, so a Try cuts no session's
// browser. The host gives each session the address of its own way in, which ~/.local/bin/chrome-mcp.sh connects to:
//
//     chrome MCP ── ws://127.0.0.1:<port>/cdp/<session id> ──► relay ──► desk's app, on its DevTools port
//
// Claude's tabs live in desk's app (apps/desktop/src/tabs.ts), the Chrome that shows them in a chat's Browser (1 Nov).
// The relay passes each session's CDP through as it is but for two things:
// - Its Target.createTarget, which Electron answers with "Not supported": the relay asks the app for the tab instead,
//   on the app's socket, and answers with it once the session heard the tab attach, as Chrome's own answer would come
//   (Playwright looks the new tab up by the answer's id: its coreBundle.js, doCreateNewPage).
// - desk's own pages, its window and its developer tools, which the same Chrome holds: the session hears only of tabs
//   in the context Claude's tabs keep their logins in, and the relay lets go of any other it was attached to, freeing
//   one Playwright's auto-attach holds before it runs (waitForDebuggerOnStart).
// A tab opened from a session's tab, a popup or a link to a new tab, is that session's too, which the relay's own watcher
// sees: one connection straight to the app, which ends as the app stops, its tabs with it.
//
// desk also opens a tab for a session itself, a link you clicked in its chat (open, below), which is that session's.
//
// It also tells desk which of its tabs a session works in, as it navigates, clicks, types, takes a screenshot or picks
// the tab (used, below), for desk to open the chat's Browser on it ("on using browser, the desk should open the browser
// tab", the user, 1 Nov).
//
// What it noted lives only as long as the host. desk keeps it (tabs.ts), and gives a new host's relay the tabs a host
// before it noted (adopt), each of them that session's again while it is open.
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

// A second desk for testing points both at another desk app with DESK_CHROME_PORT and DESK_APP_SOCKET.
const APP = `http://127.0.0.1:${process.env.DESK_CHROME_PORT || 9337}`; // its DevTools, which refuse while it is down
const SOCKET = process.env.DESK_APP_SOCKET || join(process.env.XDG_RUNTIME_DIR || tmpdir(), "desk-app.sock"); // where it opens a tab
const OURS = 1e9; // the ids of the relay's own calls on a session's connection, above any Playwright reaches
const ATTACH = 5000; // ms an answer to Target.createTarget waits for the tab's attach
const BIGGEST = 512 * 1024 * 1024; // bytes in one message: a full-page screenshot comes back as one
const EVERY = 2000; // ms between the watcher's asks for every tab
const AGAIN = 1000; // ms a session works on in the same tab before the relay says so again: less than a turn takes to start
// What a session sends a tab as it works there. Not reading the page, which Playwright does the same way in every tab it
// connects to or lists (1 Nov: Runtime.evaluate and callFunctionOn, on connect, a snapshot and browser_tabs list alike).
const ACTS = /"method":"(Page\.(navigate|reload|navigateToHistoryEntry|bringToFront|captureScreenshot|handleJavaScriptDialog)|Input\.\w+|DOM\.setFileInputFiles)"/;

export interface Tab { target: string; session: string; url: string; title: string }
export type TabNews = { type: "tab" } & Tab | { type: "tab-closed"; target: string } | { type: "tab-used"; target: string; session: string };

const pages = new Map<string, { url: string; title: string; opener?: string; said?: string }>(); // the app's open pages, by target id
const owners = new Map<string, string>(); // the session that opened each tab, by its target id
let tell: (news: TabNews) => void = () => {};

// Listen on 127.0.0.1:<port>, telling what each session's tabs do as they change.
export function start(port: number, told: (news: TabNews) => void): Promise<void> {
  tell = told;
  const wss = new WebSocketServer({ noServer: true, maxPayload: BIGGEST });
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const session = /^\/cdp\/([\w-]+)$/.exec(req.url ?? "")?.[1];
    if (!session) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (mcp) => pipe(mcp, session));
  });
  void watch(); // the app may be up already, with tabs a host before this one noted
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

// One session's connection: through to the app's, both ways, its new tabs asked of the app, and desk's own pages kept
// from it, as the header says.
function pipe(mcp: WebSocket, session: string) {
  const held: Buffer[] = []; // what it sent before the app answered
  const hidden = new Set<string>(); // desk's pages it was attached to, by CDP session, until they are let go
  const others = new Set<string>(); // desk's pages, by target id
  const heardOf = new Set<string>(); // its tabs whose attach it heard, by target id
  const tabOf = new Map<string, string>(); // the tab each of its CDP sessions is attached to, by session id
  const waiting = new Map<string, () => void>(); // its answers to Target.createTarget, waiting for the tab's attach
  const listing = new Set<string>(); // its Target.getTargets calls, by CDP session and id
  let attaching = false; // it auto-attaches to new tabs, so each one's attach comes
  let ours = OURS, context = "";
  let app: WebSocket | null = null;
  const down = (m: object) => mcp.readyState === WebSocket.OPEN && mcp.send(JSON.stringify(m));
  const up = (data: Buffer | string) => {
    if (app?.readyState === WebSocket.OPEN) app.send(data, { binary: false });
    else held.push(Buffer.from(data));
  };
  const make = (m: Cdp) => {
    const to = m.sessionId ? { sessionId: m.sessionId } : {};
    tab(String(m.params?.url || "about:blank")).then((target) => {
      own(target, session);
      const answer = () => down({ id: m.id, ...to, result: { targetId: target } });
      if (!attaching || heardOf.has(target)) return answer();
      waiting.set(target, answer);
      setTimeout(() => waiting.delete(target) && answer(), ATTACH);
    }, (e: Error) => down({ id: m.id, ...to, error: { code: -32000, message: `desk's app made no tab: ${e.message}` } }));
  };
  // Whether a message from the app is about desk's own pages, which the session never hears: true drops it.
  const theirs = (m: Cdp): boolean => {
    const info = m.params?.targetInfo as TargetInfo | undefined;
    if (m.id !== undefined && m.id >= OURS) return true;
    if (m.sessionId && hidden.has(m.sessionId)) return true;
    if (m.method === "Target.attachedToTarget" && info) {
      if (info.browserContextId === context) {
        heardOf.add(info.targetId);
        tabOf.set(m.params!.sessionId as string, info.targetId);
        return false;
      }
      const sessionId = m.params!.sessionId as string;
      hidden.add(sessionId);
      others.add(info.targetId);
      if (m.params!.waitingForDebugger) up(JSON.stringify({ id: ours++, sessionId, method: "Runtime.runIfWaitingForDebugger" }));
      up(JSON.stringify({ id: ours++, ...(m.sessionId ? { sessionId: m.sessionId } : {}), method: "Target.detachFromTarget", params: { sessionId } }));
      return true;
    }
    if (m.method === "Target.detachedFromTarget") {
      tabOf.delete(m.params!.sessionId as string);
      return hidden.delete(m.params!.sessionId as string);
    }
    if (info) { // Target.targetCreated and targetInfoChanged
      if (info.browserContextId === context) return false;
      others.add(info.targetId);
      return true;
    }
    if (m.method === "Target.targetDestroyed" || m.method === "Target.targetCrashed") return others.has(m.params!.targetId as string);
    if (m.result?.targetInfos && listing.delete(`${m.sessionId ?? ""} ${m.id}`)) m.result.targetInfos = m.result.targetInfos.filter((t) => t.browserContextId === context);
    return false;
  };
  mcp.on("message", (data: Buffer) => {
    if (data.includes("Target.")) {
      const m = parse(data);
      if (m?.method === "Target.createTarget") return make(m);
      if (m?.method === "Target.setAutoAttach" && !m.sessionId) attaching = !!m.params?.autoAttach;
      if (m?.method === "Target.getTargets") listing.add(`${m.sessionId ?? ""} ${m.id}`);
    } else if (data.length < 10_000 && ACTS.test(data.toString())) {
      const target = tabOf.get(parse(data)?.sessionId ?? "");
      if (target) used(target, session);
    }
    up(data);
  });
  mcp.on("close", () => app?.close());
  mcp.on("error", () => {}); // it closes next
  Promise.all([call<{ context: string }>("GET", "/"), browserUrl(APP)]).then(([about, url]) => {
    if (mcp.readyState !== WebSocket.OPEN) return;
    context = about.context;
    const ws = (app = new WebSocket(url, { perMessageDeflate: false, maxPayload: BIGGEST }));
    ws.on("open", () => {
      for (const data of held.splice(0)) ws.send(data, { binary: false });
      void watch(); // the app runs now, if it did not before
    });
    ws.on("message", (data: Buffer) => {
      // Only a small message, or one about targets, can be about desk's pages: a screenshot is neither, and is not parsed
      if (data.length < 2000 || data.includes("Target.") || data.includes("targetInfos")) {
        const m = parse(data);
        if (m && theirs(m)) return;
        if (m?.result?.targetInfos) data = Buffer.from(JSON.stringify(m));
        if (m?.method === "Target.attachedToTarget") {
          if (mcp.readyState === WebSocket.OPEN) mcp.send(data, { binary: false });
          const target = (m.params!.targetInfo as TargetInfo).targetId;
          waiting.get(target)?.();
          waiting.delete(target);
          return;
        }
      }
      if (mcp.readyState === WebSocket.OPEN) mcp.send(data, { binary: false });
    });
    ws.on("close", () => mcp.close());
    ws.on("error", () => {}); // it closes next
  }, () => mcp.close(1011, "desk's app is not running"));
}

// A tab desk opens for the session at the address, which the app makes.
export async function open(session: string, url: string) {
  own(await tab(url), session);
  void watch();
}

// A new tab of Claude's at the address, made by desk's app, and its target id.
const tab = (url: string) => call<{ target: string }>("PUT", "/tabs", { url }).then((r) => r.target);

// A call to desk's app on its socket (apps/desktop/src/tabs.ts), answered with its JSON.
export function call<T>(method: "GET" | "PUT", path: string, body?: object): Promise<T> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: SOCKET, method, path, timeout: 20_000, headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => { text += d; }).on("end", () => {
        try {
          const answer = JSON.parse(text) as T & { detail?: string };
          if (res.statusCode === 200) done(answer);
          else fail(new Error(answer.detail ?? `HTTP ${res.statusCode}`));
        } catch (e) {
          fail(e as Error);
        }
      });
    });
    req.on("error", fail).on("timeout", () => req.destroy(new Error("desk's app did not answer")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// The tabs it knows the session of, as they are now.
export const tabs = (): Tab[] => [...owners].flatMap(([target, session]) => {
  const page = pages.get(target);
  return page ? [{ target, session, url: page.url, title: page.title }] : [];
});

// The tabs desk keeps that this relay did not note, which a host before it did: each still open is that session's again,
// and the rest are told closed, once the watcher has the app's every page.
export function adopt(known: { target: string; session: string }[]) {
  for (const { target, session } of known) own(target, session);
  if (listed) closeGone();
  else void watch();
}

// The session works in its tab: said when it moves to another tab, and again each second it goes on in the same,
// for desk to open its chat's Browser on it once a turn (tabs.ts). Another session's tab, which a session sees too, is
// not its own.
const working = new Map<string, { target: string; at: number }>(); // the tab each session works in, by session id

function used(target: string, session: string) {
  const was = working.get(session);
  if (owners.get(target) !== session || (was?.target === target && Date.now() - was.at < AGAIN)) return;
  working.set(session, { target, at: Date.now() });
  tell({ type: "tab-used", target, session });
}

function own(target: string, session: string) {
  if (owners.has(target)) return;
  owners.set(target, session);
  say(target);
  for (const [id, page] of pages) if (page.opener === target) own(id, session); // its popups, heard of before it was owned
}

// The tab as it is now, once its session is known, and only when it changed: Chrome says a tab's info again unchanged.
function say(target: string) {
  const page = pages.get(target), session = owners.get(target);
  if (!page || !session || page.said === `${page.url} ${page.title}`) return;
  page.said = `${page.url} ${page.title}`;
  tell({ type: "tab", target, session, url: page.url, title: page.title });
}

let watching = false;
let listed = false; // the watcher has heard of every page the app had when it connected

// Each tab noted whose page is not open: once listed, or with the app down, a tab adopted that closed meanwhile.
function closeGone() {
  for (const target of [...owners.keys()]) if (!pages.has(target)) {
    owners.delete(target);
    tell({ type: "tab-closed", target });
  }
}

// The watcher: every tab's opening, address, title and closing, as the app tells them. It tells no title a page sets
// once it has loaded (1 Nov: code.claude.com's, and one set from a script, both left the strip showing the address), so
// the watcher also asks for every tab every 2 s, and says each that changed.
async function watch() {
  if (watching) return;
  watching = true;
  const url = await browserUrl(APP).catch(() => null);
  if (!url) {
    watching = false;
    return closeGone();
  }
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let timer: NodeJS.Timeout | undefined;
  ws.on("open", () => {
    ws.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
    timer = setInterval(() => ws.send(JSON.stringify({ id: 2, method: "Target.getTargets" })), EVERY);
  });
  ws.on("message", (data: Buffer) => heard(parse(data)));
  ws.on("close", () => {
    clearInterval(timer);
    watching = listed = false;
    for (const target of owners.keys()) tell({ type: "tab-closed", target }); // the app stopped, and its tabs with it
    owners.clear();
    pages.clear();
  });
  ws.on("error", () => {}); // it closes next
}

interface TargetInfo { targetId: string; type: string; url: string; title: string; openerId?: string; browserContextId?: string }

function heard(m: Cdp | null) {
  if (m?.id === 1) { // Target.setDiscoverTargets answers after it told every tab open
    listed = true;
    return closeGone();
  }
  if (m?.id === 2) { // every tab, as it is now: only those it knows of, since one may have closed since
    for (const info of m.result?.targetInfos ?? []) if (pages.has(info.targetId)) changed(info);
    return;
  }
  const info = m?.params?.targetInfo as TargetInfo | undefined;
  if (m?.method === "Target.targetDestroyed") {
    const target = m.params!.targetId as string;
    pages.delete(target);
    if (owners.delete(target)) tell({ type: "tab-closed", target });
  } else if (info?.type === "page" && (m!.method === "Target.targetCreated" || m!.method === "Target.targetInfoChanged")) changed(info);
}

function changed(info: TargetInfo) {
  const was = pages.get(info.targetId), opener = was?.opener ?? info.openerId;
  pages.set(info.targetId, { url: info.url, title: info.title, opener, said: was?.said });
  const by = opener && owners.get(opener);
  if (by && !owners.has(info.targetId)) own(info.targetId, by);
  else say(info.targetId);
}

interface Cdp { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: { targetId?: string; targetInfos?: TargetInfo[] } }

function parse(data: Buffer): Cdp | null {
  try {
    return JSON.parse(data.toString()) as Cdp;
  } catch {
    return null;
  }
}

// The app's own WebSocket, as /json/version gives it.
async function browserUrl(base: string): Promise<string> {
  const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(20_000) });
  return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
}
