// Slack, Ownego's workspace, as the user's own login sees it, with no tab open and no app: "i still have to keep slack
// tab opened to receive noti and it might interrupt with my concentration" (the user, 2 Nov; the desk issue "desk as my
// notification center"). The company removed personal apps on 22 Oct, so desk does what the Slack tab does:
//
//   1. It reads the user's Slack cookies, `d` and `d-s`, from their Chrome's Profile 2, as desk's app reads its logins
//      (apps/desktop/src/logins.ts).
//   2. It loads one of the workspace's own pages with them, whose HTML holds the session token, xoxc-, that the tab's
//      calls use; the workspace's front page holds none, its emoji settings page does.
//   3. It opens Slack's own socket, rtm.connect, with the cookie, and Slack pushes each new message as it comes.
//
// Each message passes the door (take): an edit, a deletion, a join, a topic change, the user's own message and anything
// in their sidebar's "non-work" section is dropped there and never written ("i think currently there are a few channels
// in work category and DMs, that's all matter", 2 Nov). A DM or group DM from a person, an @mention of the user and a
// reply in a thread they wrote in are written as now, by rule; the rest of a work channel is written unjudged, for the
// firewall's Claude to judge. A DM from an app (Jira, Calendar, Slackbot) goes to Claude too, not straight to now.
//
// Nothing here logs or keeps the cookie or the token outside this process's memory, nor a message's text outside the
// notices table: the slack skill's rule.
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { HOME } from "./config.ts";
import * as notices from "./notices.ts";

const WORKSPACE = "https://ownego.slack.com";
const PROFILE = process.env.DESK_CHROME_PROFILE || join(HOME, ".config/google-chrome/Profile 2"); // as the app's
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const NON_WORK = "non-work"; // the sidebar section whose channels desk never shows
const REFRESH = 10 * 60_000; // how often the channels and the sidebar are read again
const QUIET = 90_000; // a socket that says nothing this long, pings unanswered, is taken as dead

// What Slack sends for a message, the parts desk reads.
export interface Message {
  type: string;
  subtype?: string;
  hidden?: boolean;
  channel: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string;
  attachments?: { fallback?: string; pretext?: string; title?: string; text?: string }[];
  files?: { name?: string; title?: string }[];
}

interface Place {
  kind: "dm" | "group" | "channel";
  name: string; // #imagenhub, DM, group DM with a, b
  nonWork: boolean;
}

// The login ended: the cookie is gone, or Slack no longer takes it.
export class SignedOut extends Error {}

let login: { cookie: string; token: string; me: string; handle: string } | null = null;
let places = new Map<string, Place>();
const names = new Map<string, string>();
let wrote = new Map<string, boolean>(); // channel:thread_ts, whether the user started or wrote in that thread
let socket: WebSocket | null = null;
let stopped = false;

// ---- The login: Chrome's cookie, then the page's token

const key = (password: string) => pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");

// The `d` and `d-s` cookies of .slack.com, as one Cookie header, or null when Chrome holds none.
async function readCookie(): Promise<string | null> {
  const keys: Record<string, Buffer> = { v10: key("peanuts") };
  try {
    keys.v11 = key((await promisify(execFile)("secret-tool", ["lookup", "application", "chrome"], { timeout: 5000 })).stdout);
  } catch {} // no keyring: only a v10 cookie opens
  // A copy, since Chrome holds its own open; in the user's own runtime folder, which only they reach
  const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "desk-slack-"));
  try {
    copyFileSync(join(PROFILE, "Cookies"), join(dir, "Cookies"));
    const db = new DatabaseSync(join(dir, "Cookies"), { readOnly: true });
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string }).value);
    const rows = db.prepare("SELECT name, value, encrypted_value FROM cookies WHERE host_key = '.slack.com' AND name IN ('d', 'd-s')")
      .all() as { name: string; value: string; encrypted_value: Uint8Array }[];
    db.close();
    const pairs = rows.flatMap((r) => {
      const locked = Buffer.from(r.encrypted_value);
      if (!locked.length) return [`${r.name}=${r.value}`];
      const k = keys[locked.subarray(0, 3).toString()];
      if (!k) return [];
      try {
        const d = createDecipheriv("aes-128-cbc", k, Buffer.alloc(16, " "));
        // Since the database's version 24, Chrome puts the SHA-256 of the cookie's host before its value
        return [`${r.name}=${Buffer.concat([d.update(locked.subarray(3)), d.final()]).subarray(version >= 24 ? 32 : 0)}`];
      } catch {
        return [];
      }
    });
    return pairs.some((p) => p.startsWith("d=")) ? pairs.join("; ") : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function signIn() {
  const cookie = await readCookie();
  if (!cookie) throw new SignedOut("no Slack cookie in Chrome");
  // The page as a tab loads it, the redirects followed by hand so that the cookie goes along each
  let url = `${WORKSPACE}/customize/emoji`, html = "";
  for (let i = 0; i < 6 && !html; i++) {
    const r = await fetch(url, { headers: { cookie, "user-agent": UA }, redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) url = new URL(r.headers.get("location")!, url).href;
    else html = await r.text();
  }
  const token = html.match(/"api_token":"(xoxc-[^"]+)"/)?.[1];
  if (!token) throw new SignedOut("Slack's page gave no session token");
  login = { cookie, token, me: "", handle: "" };
  const auth = await call("auth.test");
  login.me = auth.user_id as string;
  login.handle = auth.user as string;
}

// A Slack API method, as the user; its answer, or an Error naming the method and Slack's error code, never the token.
async function call(method: string, params: Record<string, string> = {}): Promise<Record<string, any>> {
  if (!login) throw new SignedOut("not signed in");
  const r = await fetch(`${WORKSPACE}/api/${method}`, {
    method: "POST",
    body: new URLSearchParams({ token: login.token, ...params }),
    headers: { cookie: login.cookie, "user-agent": UA },
  });
  if (r.status === 429) throw new Error(`${method}: rate limited`);
  const answer = (await r.json()) as Record<string, any>;
  if (answer.ok) return answer;
  if (["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(answer.error)) {
    login = null;
    throw new SignedOut(`${method}: ${answer.error}`);
  }
  throw new Error(`${method}: ${answer.error}`);
}

// ---- Where a message is: the user's channels and group DMs, and the sidebar's non-work section

async function loadPlaces() {
  const sections = (await call("users.channelSections.list")).channel_sections as { name?: string; channel_ids_page?: { channel_ids?: string[] } }[];
  const nonWork = new Set(sections.find((s) => s.name?.trim().toLowerCase() === NON_WORK)?.channel_ids_page?.channel_ids ?? []);
  const next = new Map<string, Place>();
  let cursor = "";
  do {
    const r = await call("users.conversations", { types: "public_channel,private_channel,mpim", exclude_archived: "true", limit: "500", cursor });
    for (const c of r.channels) next.set(c.id, placeOf(c, nonWork.has(c.id)));
    cursor = r.response_metadata?.next_cursor || "";
  } while (cursor);
  places = next;
  wrote = new Map();
}

function placeOf(c: Record<string, any>, nonWork: boolean): Place {
  if (c.is_im) return { kind: "dm", name: "DM", nonWork };
  if (c.is_mpim) {
    // mpdm-giaolh--minhnt--chinhdt-1: the people in it, the user left out
    const who = String(c.name).replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").filter((h) => h !== login?.handle);
    return { kind: "group", name: `group DM with ${who.join(", ")}`, nonWork };
  }
  return { kind: "channel", name: `#${c.name}`, nonWork };
}

async function place(channel: string): Promise<Place> {
  if (channel.startsWith("D")) return { kind: "dm", name: "DM", nonWork: false };
  const known = places.get(channel);
  if (known) return known;
  // A channel joined or a group DM started since the last read: in no section yet, so not non-work
  const found = placeOf((await call("conversations.info", { channel })).channel, false);
  places.set(channel, found);
  return found;
}

async function nameOf(user: string) {
  let name = names.get(user);
  if (!name) {
    const u = (await call("users.info", { user }).catch(() => ({ user: null }))).user;
    name = u?.profile?.display_name || u?.real_name || u?.name || user;
    names.set(user, name!);
  }
  return name!;
}

// An app's name, as Slack shows it over its messages: Jira Cloud, GitHub, Slackbot.
async function appOf(m: Message) {
  if (m.username || m.bot_profile?.name) return (m.username || m.bot_profile?.name)!;
  if (!m.bot_id) return m.user === "USLACKBOT" ? "Slackbot" : "an app";
  let name = names.get(m.bot_id);
  if (!name) {
    name = (await call("bots.info", { bot: m.bot_id }).catch(() => ({ bot: null }))).bot?.name || "an app";
    names.set(m.bot_id, name!);
  }
  return name!;
}

// Whether the user started the thread, or wrote in it.
async function wroteIn(channel: string, thread: string, parent?: string) {
  if (parent === login?.me) return true;
  const k = `${channel}:${thread}`;
  if (!wrote.has(k)) {
    const r = await call("conversations.replies", { channel, ts: thread, limit: "200" });
    wrote.set(k, (r.messages as Message[]).some((m) => m.user === login?.me));
  }
  return wrote.get(k)!;
}

// Slack's markup as the user reads it: <@U1> as @name, <#C1|imagenhub> as #imagenhub, <url|label> as its label.
async function plain(text: string) {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const named = new Map(await Promise.all(ids.map(async (id) => [id, await nameOf(id)] as const)));
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${named.get(id)}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, "$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// ---- A message's parts

const fromApp = (m: Message) => Boolean(m.bot_id) || m.subtype === "bot_message" || m.user === "USLACKBOT";

// Its words as Slack holds them: its text, else an app's attachments.
const rawOf = (m: Message) =>
  m.text || m.attachments?.map((a) => [a.pretext, a.title, a.text || a.fallback].filter(Boolean).join("\n")).join("\n") || "";

// Its words as the user reads them, with the files it shares named.
async function textOf(m: Message) {
  const files = m.files?.map((f) => `[file: ${f.title || f.name}]`).join(" ") ?? "";
  return [await plain(rawOf(m)), files].filter(Boolean).join("\n").slice(0, 4000);
}

// ---- The door

// What a message may be: a plain one, an app's, a file shared, a reply also sent to the channel, a /me. Every other
// subtype is an edit, a deletion, a join or leave, a topic, purpose or name change, a pin: dropped at the door.
const KEPT = new Set([undefined, "bot_message", "file_share", "thread_broadcast", "me_message"]);

// A message from the socket, or from a channel's history, through the door: the notice it makes, written, or null when
// the door dropped it, or it was written already.
export async function take(m: Message): Promise<notices.Notice | null> {
  if (m.type !== "message" || m.hidden || !KEPT.has(m.subtype) || !m.channel || !m.ts || !login) return null;
  const reply = Boolean(m.thread_ts && m.thread_ts !== m.ts);
  if (m.user === login.me) {
    if (m.thread_ts) wrote.set(`${m.channel}:${m.thread_ts}`, true);
    return null;
  }
  const at = await place(m.channel);
  if (at.nonWork) return null;
  const app = fromApp(m), raw = rawOf(m);
  const verdict =
    !app && at.kind === "dm" ? "a DM"
    : !app && at.kind === "group" ? "a group DM"
    : raw.includes(`<@${login.me}>`) ? "@you"
    : reply && (await wroteIn(m.channel, m.thread_ts!, m.parent_user_id)) ? "a reply in your thread"
    : null; // a work channel, or an app's DM: the firewall's Claude judges it
  const n: notices.Notice = {
    id: `slack:${m.channel}:${m.ts}`,
    source: "slack",
    thread: at.kind === "channel" ? `slack:${m.channel}:${m.thread_ts ?? m.ts}` : `slack:${m.channel}`,
    place: at.name,
    who: app ? await appOf(m) : await nameOf(m.user ?? ""),
    text: await textOf(m),
    link: `${WORKSPACE}/archives/${m.channel}/p${m.ts.replace(".", "")}` + (reply ? `?thread_ts=${m.thread_ts}&cid=${m.channel}` : ""),
    at: Number(m.ts),
    verdict: verdict ? "now" : null,
    why: verdict ?? "",
  };
  return (await notices.add(n)) ? n : null;
}

// ---- A thread, whole

// A thread as Slack holds it now, for a chat on its Inbox row (threads.ts): every message the door would keep, the
// user's own too, as "you", oldest first. A channel's thread is its replies, a DM's or group DM's its last DM_LAST.
const DM_LAST = 30;

export async function thread(id: string): Promise<{ who: string; at: number; text: string }[]> {
  const [, channel, ts] = id.split(":");
  if (!login) await signIn();
  const r = ts ? await call("conversations.replies", { channel, ts, limit: "200" }) : await call("conversations.history", { channel, limit: String(DM_LAST) });
  const kept = (r.messages as Message[]).filter((m) => !m.hidden && KEPT.has(m.subtype)).sort((a, b) => Number(a.ts) - Number(b.ts));
  return Promise.all(kept.map(async (m) => ({
    who: m.user === login!.me ? "you" : fromApp(m) ? await appOf(m) : await nameOf(m.user ?? ""),
    at: Number(m.ts),
    text: await textOf(m),
  })));
}

// ---- A reply, as the user

// The reply as Slack takes it: &, < and > escaped, as Slack asks, but in its own <…> markup (a link, a mention, a
// channel), and a name the thread showed as @name (plain, from Slack's <@U…>) made Slack's mention of them again, for
// the people desk has named; any other @word stays as it was.
const MARKUP = /(<(?:https?:|mailto:|[@#!])[^<>]*>)/;
function asSlack(text: string) {
  const ids = new Map([...names].filter(([id]) => /^[UW]/.test(id)).map(([id, name]) => [name.toLowerCase(), id]));
  return text.split(MARKUP).map((part, i) => i % 2 ? part : part
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/(^|[\s(])@([\w.-]*\w)/g, (all, before: string, name: string) => {
      const id = ids.get(name.toLowerCase());
      return id ? `${before}<@${id}>` : all;
    })).join("");
}

// The reply posted as the user: in the thread, or a DM's straight in the DM. The user's Send on its card in desk said so
// (replies.ts). Its link.
export async function post(id: string, text: string): Promise<string> {
  const [, channel, ts] = id.split(":");
  if (!login) await signIn();
  if (text.includes("@")) await thread(id); // names its people, for their mentions, after a restart too
  const r = await call("chat.postMessage", { channel, text: asSlack(text), ...(ts ? { thread_ts: ts } : {}) });
  return `${WORKSPACE}/archives/${channel}/p${String(r.ts).replace(".", "")}` + (ts ? `?thread_ts=${ts}&cid=${channel}` : "");
}

// ---- The socket

// One socket's life: signed in, the places read, rtm.connect's socket open until it closes. Resolves when it does.
async function session() {
  if (!login) await signIn();
  await loadPlaces();
  const { url } = await call("rtm.connect");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url, { headers: { cookie: login!.cookie, "user-agent": UA } });
    socket = ws;
    let heard = Date.now(), id = 0, queue = Promise.resolve();
    const ping = setInterval(() => {
      if (Date.now() - heard > QUIET) return ws.terminate();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++id, type: "ping" }));
    }, 30_000);
    const refresh = setInterval(() => void loadPlaces().catch((e) => console.error("slack: reading the channels,", e.message)), REFRESH);
    ws.on("message", (data) => {
      heard = Date.now();
      let m: Message;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.type === "hello") {
        const work = [...places.values()].filter((p) => p.kind === "channel" && !p.nonWork).length;
        console.log(`slack: connected as ${login?.handle}, ${work} work channels`);
      }
      if (m.type === "goodbye") ws.close();
      if (m.type === "message") queue = queue.then(() => take(m)).then(() => {}, (e) => console.error("slack: a message,", e.message));
    });
    // Its URL carries the socket's ticket: say only that it failed
    ws.on("error", () => console.error("slack: the socket failed"));
    ws.on("close", (code) => {
      clearInterval(ping);
      clearInterval(refresh);
      socket = null;
      if (!stopped) console.log(`slack: the socket closed (${code})`);
      resolve();
    });
  });
}

// Keeps a socket open while desk runs: after one closes, the next opens 5 s later, the wait doubling up to 5 minutes
// while they keep failing, and back to 5 s after one that lasted.
export function start() {
  void (async () => {
    let wait = 5_000;
    while (!stopped) {
      const began = Date.now();
      try {
        await session();
      } catch (e) {
        console.error(`slack: ${(e as Error).message}`);
      }
      if (Date.now() - began > 5 * 60_000) wait = 5_000;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 5 * 60_000);
    }
  })();
}

export function stop() {
  stopped = true;
  socket?.close();
}

// For a script trying the door on a channel's history: signs in and reads the places, as a socket's session does.
export async function ready() {
  if (!login) await signIn();
  await loadPlaces();
  return { places, call };
}
