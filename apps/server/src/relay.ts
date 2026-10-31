// The browser relay, which every desk session's chrome MCP reaches the agents' Chrome through, so that desk knows which
// session opened each tab and can show a chat its own ("i can view tabs per sessions directly on what it's doing", the
// user, 31 Oct). It runs in the session host (host.ts), which outlives desk's restarts, so a Try cuts no session's
// browser. The host gives each session the address of its own way in, which ~/.local/bin/chrome-mcp.sh connects to:
//
//     chrome MCP ── ws://127.0.0.1:<port>/cdp/<session id> ──► relay ──► 9333, the socket proxy ──► the agents' Chrome
//
// It passes each session's CDP through as it is, and reads only Chrome's answer to its Target.createTarget: the tab made
// for it. A tab opened from a session's tab, a popup or a link to a new tab, is that session's too, which the relay's own
// watcher sees: one connection straight to the Chrome on 9334. Unlike one through the proxy, it does not keep the Chrome
// running once no session uses it (the chrome skill, "How it behaves"), and it ends as the Chrome stops, its tabs with it.
//
// What it noted lives only as long as the host. desk keeps it (tabs.ts), and gives a new host's relay the tabs a host
// before it noted (adopt), each of them that session's again while it is open.
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const PROXY = "http://127.0.0.1:9333"; // starts the Chrome on its first connection, and stops it 5 minutes after the last
const CHROME = "http://127.0.0.1:9334"; // the Chrome itself, which refuses while it is down
const BIGGEST = 512 * 1024 * 1024; // bytes in one message: a full-page screenshot comes back as one

export interface Tab { target: string; session: string; url: string; title: string }
export type TabNews = { type: "tab" } & Tab | { type: "tab-closed"; target: string };

const pages = new Map<string, { url: string; title: string; opener?: string; said?: string }>(); // the Chrome's open tabs, by target id
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
  void watch(); // the Chrome may be up already, with tabs a host before this one noted
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

// One session's connection: through to the Chrome's, both ways, the tabs Chrome makes for it noted on the way.
function pipe(mcp: WebSocket, session: string) {
  const asked = new Set<string>(); // its Target.createTarget calls still waiting on Chrome's answer, by CDP session and id
  const held: Buffer[] = []; // what it sent before the Chrome answered
  let chrome: WebSocket | null = null;
  mcp.on("message", (data: Buffer) => {
    if (data.includes("Target.createTarget")) {
      const m = parse(data);
      if (m?.method === "Target.createTarget") asked.add(`${m.sessionId ?? ""} ${m.id}`);
    }
    if (chrome?.readyState === WebSocket.OPEN) chrome.send(data, { binary: false });
    else held.push(data);
  });
  mcp.on("close", () => chrome?.close());
  mcp.on("error", () => {}); // it closes next
  browserUrl(PROXY).then((url) => {
    if (mcp.readyState !== WebSocket.OPEN) return;
    const ws = (chrome = new WebSocket(url, { perMessageDeflate: false, maxPayload: BIGGEST }));
    ws.on("open", () => {
      for (const data of held.splice(0)) ws.send(data, { binary: false });
      void watch(); // the Chrome runs now, if it did not before
    });
    ws.on("message", (data: Buffer) => {
      if (asked.size && data.length < 1000) {
        const m = parse(data);
        if (m && asked.delete(`${m.sessionId ?? ""} ${m.id}`) && m.result?.targetId) own(m.result.targetId, session);
      }
      if (mcp.readyState === WebSocket.OPEN) mcp.send(data, { binary: false });
    });
    ws.on("close", () => mcp.close());
    ws.on("error", () => {}); // it closes next
  }, () => mcp.close(1011, "The agents' Chrome did not start"));
}

// The tabs it knows the session of, as they are now.
export const tabs = (): Tab[] => [...owners].flatMap(([target, session]) => {
  const page = pages.get(target);
  return page ? [{ target, session, url: page.url, title: page.title }] : [];
});

// The tabs desk keeps that this relay did not note, which a host before it did: each still open is that session's again,
// and the rest are told closed, once the watcher has the Chrome's every tab.
export function adopt(known: { target: string; session: string }[]) {
  for (const { target, session } of known) own(target, session);
  if (listed) closeGone();
  else void watch();
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
let listed = false; // the watcher has heard of every tab the Chrome had when it connected

// Each tab noted whose page is not open: once listed, or with the Chrome down, a tab adopted that closed meanwhile.
function closeGone() {
  for (const target of [...owners.keys()]) if (!pages.has(target)) {
    owners.delete(target);
    tell({ type: "tab-closed", target });
  }
}

// The watcher: every tab's opening, address, title and closing, as the Chrome tells them.
async function watch() {
  if (watching) return;
  watching = true;
  const url = await browserUrl(CHROME).catch(() => null);
  if (!url) {
    watching = false;
    return closeGone();
  }
  const ws = new WebSocket(url, { perMessageDeflate: false });
  ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } })));
  ws.on("message", (data: Buffer) => heard(parse(data)));
  ws.on("close", () => {
    watching = listed = false;
    for (const target of owners.keys()) tell({ type: "tab-closed", target }); // the Chrome stopped, and its tabs with it
    owners.clear();
    pages.clear();
  });
  ws.on("error", () => {}); // it closes next
}

interface TargetInfo { targetId: string; type: string; url: string; title: string; openerId?: string }

function heard(m: Cdp | null) {
  if (m?.id === 1) { // Target.setDiscoverTargets answers after it told every tab open
    listed = true;
    return closeGone();
  }
  const info = m?.params?.targetInfo as TargetInfo | undefined;
  if (m?.method === "Target.targetDestroyed") {
    const target = m.params!.targetId as string;
    pages.delete(target);
    if (owners.delete(target)) tell({ type: "tab-closed", target });
  } else if (info?.type === "page" && (m!.method === "Target.targetCreated" || m!.method === "Target.targetInfoChanged")) {
    const was = pages.get(info.targetId), opener = was?.opener ?? info.openerId;
    pages.set(info.targetId, { url: info.url, title: info.title, opener, said: was?.said });
    const by = opener && owners.get(opener);
    if (by && !owners.has(info.targetId)) own(info.targetId, by);
    else say(info.targetId);
  }
}

interface Cdp { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: { targetId?: string } }

function parse(data: Buffer): Cdp | null {
  try {
    return JSON.parse(data.toString()) as Cdp;
  } catch {
    return null;
  }
}

// The Chrome's own WebSocket, as /json/version gives it: through the proxy, its address names the proxy's port.
async function browserUrl(base: string): Promise<string> {
  const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(20_000) });
  return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
}
