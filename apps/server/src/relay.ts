// The browser relay, which every desk session's desk-browser MCP reaches Claude's tabs through, so that desk knows which
// session opened each tab and can show a chat its own ("i can view tabs per sessions directly on what it's doing", the
// user, 31 Oct). It runs in the session host (host.ts), which outlives desk's restarts, so a restart cuts no
// session's browser. The host gives each session the address of its own way in, as its desk-browser MCP server:
//
//     desk-browser MCP ── ws://127.0.0.1:<port>/cdp/<session id> ──► relay ──► desk's headless Chrome (chrome.ts)
//
// Claude's tabs live in desk's own Chrome, headless, which the relay starts the first time a session connects or desk
// opens a tab, and stops once nothing has used it for a while (8 Nov; until then Electron held them, on a screen nobody
// saw). Each session's tabs are a browser context of their own, which the relay makes for it, and a tab is the session's
// whose context it is in: a popup or a link opened to a new tab from one of its tabs too, which the relay's own watcher
// sees, one connection straight to the Chrome that ends as the Chrome stops, its tabs with it.
//
// The relay passes each session's CDP through as it is but for:
// - Its Target.createTarget, which it gives the session's context, in a window of its own: a headless Chrome draws only
//   the tab in front of each window (1 Nov), and a chat's Browser shows the tab live.
// - Its Browser.close, which would end every session's tabs: answered, and not passed on.
// - Every other context's tabs, and the Chrome's own first tab: the session hears only of tabs in its own context, and
//   the relay lets go of any other it was attached to, freeing one Playwright's auto-attach holds before it runs
//   (waitForDebuggerOnStart).
//
// desk also opens a tab for a session itself, a link you clicked in its chat (open, below), which is that session's.
//
// It also tells desk which of its tabs a session works in, as it navigates, clicks, types, takes a screenshot or picks
// the tab (used, below), for desk to open the chat's Browser on it ("on using browser, the desk should open the browser
// tab", the user, 1 Nov).
//
// What it noted lives only as long as the host. desk keeps it (tabs.ts), and gives a new host's relay the tabs a host
// before it noted (adopt), each of them that session's again while it is open, and its context with it.
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import * as chrome from "./chrome.ts";

const OURS = 1e9; // the ids of the relay's own calls on a session's connection, above any Playwright reaches
const ATTACH = 5000; // ms an answer to Target.createTarget waits for the tab's attach
// ms a tab has to answer once the session is attached to it, before the session hears of it: Playwright's connect waits
// for every page it is attached to, so one whose renderer never answers timed out every chat's (2 Nov, a tab whose
// reload needed a process the app could no longer start)
const ANSWER = 3000;
const BIGGEST = 512 * 1024 * 1024; // bytes in one message: a full-page screenshot comes back as one
const EVERY = 2000; // ms between the watcher's asks for every tab
const AGAIN = 1000; // ms a session works on in the same tab before the relay says so again: less than a turn takes to start
// What a session sends a tab as it works there. Not reading the page, which Playwright does the same way in every tab it
// connects to or lists (1 Nov: Runtime.evaluate and callFunctionOn, on connect, a snapshot and browser_tabs list alike).
const ACTS = /"method":"(Page\.(navigate|reload|navigateToHistoryEntry|bringToFront|captureScreenshot|handleJavaScriptDialog)|Input\.\w+|DOM\.setFileInputFiles)"/;

export interface Tab { target: string; session: string; url: string; title: string }
export type TabNews = { type: "tab" } & Tab | { type: "tab-closed"; target: string } | { type: "tab-used"; target: string; session: string };

const pages = new Map<string, { url: string; title: string; opener?: string; context?: string; said?: string }>(); // the Chrome's open pages, by target id
const owners = new Map<string, string>(); // the session that opened each tab, by its target id
const contexts = new Map<string, Promise<string>>(); // each session's browser context, by session
const sessionOf = new Map<string, string>(); // the session whose context it is, by context
let pipes = 0; // sessions connected now
let tell: (news: TabNews) => void = () => {};

const PORTS = 4; // ports a relay tries, one after another: one host per landing still draining, the newest on the next

// Listen on 127.0.0.1, on the first port free from first, telling what each session's tabs do as they change; it answers
// with the port.
export async function start(first: number, told: (news: TabNews) => void): Promise<number> {
  tell = told;
  const wss = new WebSocketServer({ noServer: true, maxPayload: BIGGEST });
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const session = /^\/cdp\/([\w-]+)$/.exec(req.url ?? "")?.[1];
    if (!session) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (mcp) => pipe(mcp, session));
  });
  for (let port = first; ; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => (server.off("error", reject), resolve()));
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && port < first + PORTS - 1) continue;
      throw e;
    }
    void watch(); // the Chrome may be up already, with tabs a host before this one noted
    return port;
  }
}

// One session's connection: through to the Chrome's, both ways, its new tabs made in its own context, and every other
// context's kept from it, as the header says.
function pipe(mcp: WebSocket, session: string) {
  pipes++;
  const held: Buffer[] = []; // what it sent before the Chrome answered
  const hidden = new Set<string>(); // other contexts' pages it was attached to, by CDP session, until they are let go
  const others = new Set<string>(); // other contexts' pages, by target id
  const passed = new Set<string>(); // its tabs whose attach it was given, once the tab answered, by target id
  const tabOf = new Map<string, string>(); // the tab each of its CDP sessions is attached to, by session id
  const creating = new Set<string>(); // its Target.createTarget calls, by CDP session and id
  const waiting = new Map<string, () => void>(); // their answers, waiting for the tab's attach
  const listing = new Set<string>(); // its Target.getTargets calls, by CDP session and id
  const stuck = new Set<string>(); // its tabs that did not answer when attached, hidden as other contexts' are, by target id
  let attaching = false; // it auto-attaches to new tabs, so each one's attach comes
  let autoAttach: number | undefined; // its Target.setAutoAttach call's id, whose answer comes after the tabs' attaches
  const checking = new Set<Promise<void>>(); // the attaches waiting on their tab's answer
  const mine = new Map<number, (m: Cdp) => void>(); // the relay's own calls on it, waiting for their answers
  let ours = OURS, context = "";
  let app: WebSocket | null = null;
  const down = (m: object) => mcp.readyState === WebSocket.OPEN && mcp.send(JSON.stringify(m));
  const up = (data: Buffer | string) => {
    if (app?.readyState === WebSocket.OPEN) app.send(data, { binary: false });
    else held.push(Buffer.from(data));
  };
  // Its new tab, in its own context and a window of its own, as the header says. Chrome's answer waits for the tab's
  // attach to be passed on, which waits on the tab's answer (attached, below): Playwright looks the tab up by the
  // answer's target id among the attaches it was given (its coreBundle.js, doCreateNewPage).
  const made = (m: Cdp) => JSON.stringify({ ...m, params: { ...m.params, browserContextId: context, newWindow: true } });
  const make = (m: Cdp) => {
    creating.add(`${m.sessionId ?? ""} ${m.id}`);
    up(made(m));
  };
  const answered = (m: Cdp, data: Buffer) => {
    const target = m.result?.targetId;
    const answer = () => mcp.readyState === WebSocket.OPEN && mcp.send(data, { binary: false });
    if (!target || !attaching || passed.has(target)) return answer();
    waiting.set(target, answer);
    setTimeout(() => waiting.delete(target) && answer(), ATTACH);
  };
  // A call of the relay's own on the session's connection, answered with the app's answer.
  const ask = (sessionId: string | undefined, method: string, params: object = {}) => new Promise<Cdp>((done) => {
    const id = ours++;
    mine.set(id, done);
    up(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), method, params }));
  });
  // Whether the page the session was just attached to answers, within ANSWER ms, a call its renderer answers with no
  // script run, as one waiting for the debugger still does
  const answers = (sessionId: string) => {
    let late: NodeJS.Timeout;
    const asked = ask(sessionId, "Page.getFrameTree").then(() => true);
    const id = ours - 1;
    return Promise.race([asked, new Promise<boolean>((done) => (late = setTimeout(() => (mine.delete(id), done(false)), ANSWER)))]).finally(() => clearTimeout(late));
  };
  // The session's attach to its tab, passed on once the tab answers; one that does not is let go, as other contexts' are
  const attached = async (data: Buffer, m: Cdp) => {
    const info = m.params!.targetInfo as TargetInfo, sessionId = m.params!.sessionId as string;
    if (info.type === "page" && !m.sessionId && !(await answers(sessionId))) {
      console.log(`relay: ${session}'s tab ${info.targetId} (${info.url}) did not answer in ${ANSWER / 1000} s; hidden from it`);
      stuck.add(info.targetId);
      tabOf.delete(sessionId);
      hidden.add(sessionId);
      if (m.params!.waitingForDebugger) up(JSON.stringify({ id: ours++, sessionId, method: "Runtime.runIfWaitingForDebugger" }));
      up(JSON.stringify({ id: ours++, method: "Target.detachFromTarget", params: { sessionId } }));
      return;
    }
    if (mcp.readyState === WebSocket.OPEN) mcp.send(data, { binary: false });
    passed.add(info.targetId);
    waiting.get(info.targetId)?.();
    waiting.delete(info.targetId);
  };
  // Whether a message from the Chrome is about another context's pages, which the session never hears: true drops it.
  const theirs = (m: Cdp): boolean => {
    const info = m.params?.targetInfo as TargetInfo | undefined;
    if (m.id !== undefined && m.id >= OURS) {
      mine.get(m.id)?.(m);
      mine.delete(m.id);
      return true;
    }
    if (m.sessionId && hidden.has(m.sessionId)) return true;
    if (m.method === "Target.attachedToTarget" && info) {
      if (info.browserContextId === context) {
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
      if (info.browserContextId === context && !stuck.has(info.targetId)) return false;
      others.add(info.targetId);
      return true;
    }
    if (m.method === "Target.targetDestroyed" || m.method === "Target.targetCrashed") return others.has(m.params!.targetId as string) || stuck.has(m.params!.targetId as string);
    if (m.result?.targetInfos && listing.delete(`${m.sessionId ?? ""} ${m.id}`)) m.result.targetInfos = m.result.targetInfos.filter((t) => t.browserContextId === context && !stuck.has(t.targetId));
    return false;
  };
  mcp.on("message", (data: Buffer) => {
    if (data.includes("Target.")) {
      const m = parse(data);
      if (m?.method === "Target.createTarget") return make(m);
      if (m?.method === "Target.setAutoAttach" && !m.sessionId) (attaching = !!m.params?.autoAttach), (autoAttach = m.id);
      if (m?.method === "Target.getTargets") listing.add(`${m.sessionId ?? ""} ${m.id}`);
    } else if (data.includes("Browser.close")) {
      const m = parse(data);
      if (m?.method === "Browser.close") return down({ id: m.id, result: {} });
    } else if (data.length < 10_000 && ACTS.test(data.toString())) {
      const m = parse(data), target = tabOf.get(m?.sessionId ?? "");
      if (target) used(target, session);
    }
    up(data);
  });
  mcp.on("close", () => {
    pipes--;
    app?.close();
  });
  mcp.on("error", () => {}); // it closes next
  Promise.all([chrome.up(), contextOf(session)]).then(([url, its]) => {
    if (mcp.readyState !== WebSocket.OPEN) return;
    context = its;
    const ws = (app = new WebSocket(url, { perMessageDeflate: false, maxPayload: BIGGEST }));
    ws.on("open", () => {
      // what it asked before its context was known: a new tab of its goes in its context all the same
      for (const data of held.splice(0)) {
        const m = data.includes("Target.createTarget") ? parse(data) : null;
        ws.send(m?.method === "Target.createTarget" ? made(m) : data, { binary: false });
      }
      void watch(); // the Chrome runs now, if it did not before
    });
    ws.on("message", (data: Buffer) => {
      // Only a small message, or one about targets, can be about another context's pages or answer the relay: a screenshot is
      // neither, and is not parsed
      if (data.length < 2000 || data.includes("Target.") || data.includes("targetInfos") || (mine.size && data.length < 10_000)) {
        const m = parse(data);
        if (m && theirs(m)) return;
        if (m?.result?.targetInfos) data = Buffer.from(JSON.stringify(m));
        if (m?.method === "Target.attachedToTarget") {
          const done = attached(data, m).finally(() => checking.delete(done));
          return void checking.add(done);
        }
        if (m?.id !== undefined && creating.delete(`${m.sessionId ?? ""} ${m.id}`)) return answered(m, data);
        // Chrome answers it after the attach to every open tab, which Playwright's connect counts on: so does the relay
        if (m && m.id === autoAttach && !m.sessionId && checking.size) {
          autoAttach = undefined;
          return void Promise.all(checking).then(() => mcp.readyState === WebSocket.OPEN && mcp.send(data, { binary: false }));
        }
      }
      if (mcp.readyState === WebSocket.OPEN) mcp.send(data, { binary: false });
    });
    ws.on("close", () => mcp.close());
    ws.on("error", () => {}); // it closes next
  }, (e: Error) => mcp.close(1011, `desk's Chrome did not start: ${e.message}`.slice(0, 120)));
}

// A tab desk opens for the session at the address, in the session's context.
export async function open(session: string, url: string) {
  const context = await contextOf(session);
  const { targetId } = await browser<{ targetId: string }>("Target.createTarget", { url, browserContextId: context, newWindow: true });
  own(targetId, session);
  void watch();
}

// The session's browser context: the one its tabs are in, when a host before this one made it, else a new one, which
// outlives the connection that made it, as Chrome keeps a context it was not asked to dispose of.
async function contextOf(session: string): Promise<string> {
  const known = contexts.get(session);
  if (known) return known;
  const made = (async () => {
    await chrome.up();
    if ([...owners.values()].includes(session)) await listing(); // its tabs' context, once the watcher heard of them
    const had = [...owners].find(([target, s]) => s === session && pages.get(target)?.context)?.[0];
    return had ? pages.get(had)!.context! : (await browser<{ browserContextId: string }>("Target.createBrowserContext", {})).browserContextId;
  })();
  contexts.set(session, made);
  made.then((context) => sessionOf.set(context, session), () => contexts.delete(session));
  return made;
}

// A call to the Chrome's browser, on a connection of its own, answered with its result.
async function browser<T>(method: string, params: object): Promise<T> {
  const ws = new WebSocket(await chrome.up(), { perMessageDeflate: false });
  return new Promise<T>((done, fail) => {
    const late = setTimeout(() => (ws.close(), fail(new Error(`${method} had no answer`))), 10_000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (data: Buffer) => {
      const m = parse(data) as (Cdp & { error?: { message: string } }) | null;
      if (m?.id !== 1) return;
      clearTimeout(late);
      ws.close();
      if (m.error) fail(new Error(m.error.message));
      else done(m.result as T);
    });
    ws.on("error", (e) => (clearTimeout(late), fail(e)));
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
  const context = pages.get(target)?.context; // a tab adopted from a host before this one: its context is the session's
  if (context && !sessionOf.has(context) && !contexts.has(session)) {
    sessionOf.set(context, session);
    contexts.set(session, Promise.resolve(context));
  }
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
let listed = false; // the watcher has heard of every page the Chrome had when it connected
let hear: (() => void)[] = []; // those waiting for it to have
let busy = Date.now(); // when a session last was connected or held a tab

// Once the watcher has heard of every page, or in 3 s.
const listing = () => (listed ? Promise.resolve() : new Promise<void>((done) => {
  hear.push(done);
  setTimeout(done, 3000);
  void watch();
}));

// Each tab noted whose page is not open: once listed, or with the Chrome down, a tab adopted that closed meanwhile.
function closeGone() {
  for (const target of [...owners.keys()]) if (!pages.has(target)) {
    owners.delete(target);
    tell({ type: "tab-closed", target });
  }
}

// The watcher: every tab's opening, address, title and closing, as the Chrome tells them. It tells no title a page sets
// once it has loaded (1 Nov: code.claude.com's, and one set from a script, both left the strip showing the address), so
// the watcher also asks for every tab every 2 s, and says each that changed. It stops the Chrome once no session has
// been connected and no tab open for chrome.IDLE.
async function watch() {
  if (watching) return;
  watching = true;
  const url = await chrome.address();
  if (!url) {
    watching = false;
    for (const done of hear.splice(0)) done();
    return closeGone();
  }
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let timer: NodeJS.Timeout | undefined;
  busy = Date.now();
  ws.on("open", () => {
    ws.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
    timer = setInterval(() => {
      ws.send(JSON.stringify({ id: 2, method: "Target.getTargets" }));
      if (pipes > 0 || owners.size > 0) busy = Date.now();
      else if (Date.now() - busy > chrome.IDLE) {
        busy = Date.now();
        console.log(`relay: no tab and no session for ${chrome.IDLE / 60_000} minutes; stopping desk's Chrome`);
        void chrome.stop();
      }
    }, EVERY);
  });
  ws.on("message", (data: Buffer) => heard(parse(data)));
  ws.on("close", () => {
    clearInterval(timer);
    watching = listed = false;
    for (const target of owners.keys()) tell({ type: "tab-closed", target }); // the Chrome stopped, and its tabs with it
    owners.clear();
    pages.clear();
    contexts.clear(); // and its contexts
    sessionOf.clear();
  });
  ws.on("error", () => {}); // it closes next
}

interface TargetInfo { targetId: string; type: string; url: string; title: string; openerId?: string; browserContextId?: string }

function heard(m: Cdp | null) {
  if (m?.id === 1) { // Target.setDiscoverTargets answers after it told every tab open
    listed = true;
    for (const done of hear.splice(0)) done();
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
  pages.set(info.targetId, { url: info.url, title: info.title, opener, context: info.browserContextId, said: was?.said });
  const by = (info.browserContextId && sessionOf.get(info.browserContextId)) || (opener && owners.get(opener));
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
