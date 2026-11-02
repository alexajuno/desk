// The tabs each desk session has open in the agents' Chrome, which a chat's Browser shows ("i can view tabs per sessions
// directly on what it's doing", the user, 31 Oct). The session host's browser relay (relay.ts) notes the session that
// opened each, and tells desk over the host's socket (turns.ts), which keeps them in the tabs table:
//
//     {"type": "tab", "target": "<Chrome's id>", "session": "<id>", "url": "...", "title": "..."}   opened, or it moved
//     {"type": "tab-closed", "target": "<Chrome's id>"}
//     {"type": "tab-used", "target": "<Chrome's id>", "session": "<id>"}         the session works in it
//
// The relay lives as long as its host, and a new host's knows none of the tabs. So its hello says what it noted, and desk
// answers with the rest it keeps, {"type": "owners", "tabs": [{target, session}, ...]}: the relay takes back each one
// still open, and says the others closed, a draining host's sessions' too, which keep them once they move to it. A host
// with no relay leaves no tab known, and the table empties, unless another host's relay runs.
import type { Transaction } from "@electric-sql/pglite";
import type { WebSocket } from "ws";
import * as db from "./db.ts";
import type { Tab } from "./relay.ts";

const keep = (tx: Transaction, t: Tab) =>
  tx.query<{ fresh: boolean }>(`insert into tabs (target, session, url, title, opened) values ($1, $2, $3, $4, $5)
    on conflict (target) do update set url = excluded.url, title = excluded.title returning (xmax = 0) as fresh`,
    [t.target, t.session, t.url ?? "", t.title ?? "", new Date().toISOString()]);

// A tab the session opened, or one that moved. One just opened, and one the session works in, is told to those
// listening, which open its chat's Browser on it in every app (sync.ts): the Chrome has no window, and the Browser is
// where you see what Claude does there ("when browser is in use, will the browsre tab show?", "on using browser, the
// desk should open the browser tab", the user, 1 Nov). Each tab once a turn, by when the user last wrote to the session
// (turn): a Browser you close while Claude goes on in the same tab stays closed until its next turn, or another tab.
const showers = new Set<(t: { target: string; session: string }) => void>();
export const onShow = (fn: (t: { target: string; session: string }) => void) => { showers.add(fn); };
const shown = new Map<string, { target: string; turn: unknown }>(); // the tab each session's Browser was last opened on

export async function opened(t: Tab, turn: unknown) {
  const fresh = await db.write(async (tx) => (await keep(tx, t)).rows[0]?.fresh);
  if (fresh) used(t.target, t.session, turn);
}

export function used(target: string, session: string, turn: unknown) {
  const was = shown.get(session);
  if (was?.target === target && was.turn === turn) return;
  shown.set(session, { target, turn });
  for (const fn of showers) fn({ target, session });
}

// A tab that closed. When it was its session's last, those listening close that chat's Browser in every app, which
// would show nothing ("after claude is done with browser usage, it closes the browser but doesn’t close the tab, leaving
// an empty browser sidebar... it should close the sidebar too", the user, 1 Nov).
const closers = new Set<(session: string) => void>();
export const onLastClosed = (fn: (session: string) => void) => { closers.add(fn); };

export async function closed(target: string) {
  const last = await db.write(async (tx) => {
    const session = (await tx.query<{ session: string }>("delete from tabs where target = $1 returning session", [target])).rows[0]?.session;
    return session && !(await tx.query("select 1 from tabs where session = $1 limit 1", [session])).rows.length ? session : null;
  });
  if (!last) return;
  shown.delete(last);
  for (const fn of closers) fn(last);
}

// A host's hello: relay, whether its relay runs, and tabs, the ones it noted; another, whether the relay of another host,
// one draining beside it (hosted.ts), runs and keeps the tabs.
export async function hello(ws: WebSocket, relay: boolean | undefined, tabs: Tab[], another = false) {
  const rest = await db.write(async (tx) => {
    if (!relay) {
      if (!another) await tx.query("delete from tabs");
      return;
    }
    for (const t of tabs) await keep(tx, t);
    return (await tx.query<{ target: string; session: string }>("select target, session from tabs where not (target = any($1))",
      [tabs.map((t) => t.target)])).rows;
  });
  if (rest?.length) ws.send(JSON.stringify({ type: "owners", tabs: rest }));
}

// Each tab's site icon, for its pill in the chat's Browser, which the page cannot load from the site itself: the icon
// is often not at /favicon.ico, and a site may refuse it to another site's page (code.claude.com's leads to a page
// claude.com gives only to its own). desk fetches the icon the page's HTML names, else /favicon.ico, without the
// user's cookies, and keeps it by the site, none included, as long as it runs.
type Icon = { type: string; body: Buffer } | null;
const icons = new Map<string, Promise<Icon>>();

export async function icon(target: string): Promise<Icon> {
  const url = (await db.sql().query<{ url: string }>("select url from tabs where target = $1", [target])).rows[0]?.url;
  if (!url || !/^https?:/.test(url)) return null;
  const site = new URL(url).origin;
  if (!icons.has(site)) icons.set(site, fetchIcon(url));
  return icons.get(site)!;
}

const get = (url: string) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(4000), headers: { "user-agent": "Mozilla/5.0 (desk)" } }).catch(() => null);

async function fetchIcon(url: string): Promise<Icon> {
  const page = await get(url);
  let named: string | null = null;
  if (page?.ok && page.headers.get("content-type")?.includes("html")) {
    for (const tag of (await page.text()).slice(0, 300_000).match(/<link\b[^>]*>/gi) ?? []) {
      const rel = /\brel=["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase().split(/\s+/) ?? [];
      const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
      if (rel.includes("icon") && href) {
        named = new URL(href.replaceAll("&amp;", "&"), page.url).href;
        break;
      }
    }
  }
  for (const src of [named, new URL("/favicon.ico", url).href]) {
    const res = src ? await get(src) : null;
    const type = res?.headers.get("content-type") ?? "";
    if (res?.ok && type.startsWith("image/")) return { type, body: Buffer.from(await res.arrayBuffer()) };
  }
  return null;
}
