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
// in work category and DMs, that's all matter", 2 Nov), save an @mention of the user, which Slack's tab would have
// pinged wherever it came. A DM or group DM from a person, an @mention of the user and a reply in a thread they wrote in
// are written as now, by rule; the rest of a work channel is written unjudged, for the firewall's Claude to judge. A DM
// from an app (Jira, Calendar, Slackbot) goes to Claude too, not straight to now. A thread attached to a chat comes in
// from a non-work channel too, and goes to that chat rather than to a rule or the firewall (notices.ts, add).
//
// What came while no socket was open, a desk that was down, a socket that closed or one Slack refused, desk reads back
// (readBack): once a socket opens, and each minute while none does. A login that ended (SignedOut) the Inbox says once
// (logins.ts), and desk tries it again each minute, so that one made again in Chrome is picked up within the minute.
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
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import { sql } from "./db.ts";
import * as logins from "./logins.ts";
import * as notices from "./notices.ts";

const WORKSPACE = "https://ownego.slack.com";
const profile = () => process.env.DESK_CHROME_PROFILE || join(HOME, ".config/google-chrome/Profile 2"); // as the app's
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
  files?: SlackFile[];
  reactions?: { name: string; count?: number; users?: string[] }[]; // name as Slack's :name:, a skin tone after ::
}

interface SlackFile {
  name?: string;
  title?: string;
  pretty_type?: string; // PNG, PDF, Plain Text
  filetype?: string;
  size?: number; // bytes
  permalink?: string;
  mode?: string; // hosted, external, snippet; tombstone once deleted
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
    copyFileSync(join(profile(), "Cookies"), join(dir, "Cookies"));
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

// Signed in, or SignedOut when the login ended, which the Inbox then says once (logins.ts). Slack down, or no network, is
// a plain Error: the login may still hold.
async function signIn() {
  const cookie = await readCookie();
  if (!cookie) throw ended(new SignedOut("no Slack cookie in Chrome"));
  // The page as a tab loads it, the redirects followed by hand so that the cookie goes along each
  let url = `${WORKSPACE}/customize/emoji`, html = "";
  for (let i = 0; i < 6 && !html; i++) {
    const r = await fetch(url, { headers: { cookie, "user-agent": UA }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) url = new URL(r.headers.get("location")!, url).href;
    else if (!r.ok) throw new Error(`Slack's page answered ${r.status}`);
    else html = await r.text();
  }
  const token = html.match(/"api_token":"(xoxc-[^"]+)"/)?.[1];
  if (!token) throw ended(new SignedOut("Slack's page gave no session token"));
  login = { cookie, token, me: "", handle: "" };
  const auth = await call("auth.test");
  login.me = auth.user_id as string;
  login.handle = auth.user as string;
  await logins.holds("slack");
}

// A refusal only a new login mends, told once; the error, to throw.
function ended(e: SignedOut) {
  void logins.end("slack", e.message).catch((x) => console.error("slack: keeping the login's end,", x.message));
  return e;
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
    throw ended(new SignedOut(`${method}: ${answer.error}`));
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

// What a channel is, for a thread a chat attaches by its link (threads.ts, idOf), and whether the user is in it: desk
// hears only their channels, the ones users.conversations lists.
export async function channelOf(channel: string): Promise<{ kind: Place["kind"]; member: boolean }> {
  if (channel.startsWith("D")) return { kind: "dm", member: true };
  if (!login) await signIn();
  const known = places.get(channel);
  if (known) return { kind: known.kind, member: true };
  const c = (await call("conversations.info", { channel })).channel;
  return { kind: placeOf(c, false).kind, member: Boolean(c.is_member) };
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

// Its address in Slack, a reply's in its thread.
const linkOf = (m: Message) => `${WORKSPACE}/archives/${m.channel}/p${m.ts.replace(".", "")}`
  + (m.thread_ts && m.thread_ts !== m.ts ? `?thread_ts=${m.thread_ts}&cid=${m.channel}` : "");

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
  const thread = at.kind === "channel" ? `slack:${m.channel}:${m.thread_ts ?? m.ts}` : `slack:${m.channel}`;
  const app = fromApp(m), raw = rawOf(m), mentioned = raw.includes(`<@${login.me}>`);
  if (at.nonWork && !mentioned && !chats.attached().has(thread)) return null; // an @you comes in from anywhere, as Slack's tab would ping it
  const verdict =
    !app && at.kind === "dm" ? "a DM"
    : !app && at.kind === "group" ? "a group DM"
    : mentioned ? "@you"
    : reply && (await wroteIn(m.channel, m.thread_ts!, m.parent_user_id)) ? "a reply in your thread"
    : null; // a work channel, or an app's DM: the firewall's Claude judges it
  const n: notices.Notice = {
    id: `slack:${m.channel}:${m.ts}`,
    source: "slack",
    thread,
    place: at.name,
    who: app ? await appOf(m) : await nameOf(m.user ?? ""),
    text: await textOf(m),
    link: linkOf(m),
    at: Number(m.ts),
    verdict: verdict ? "now" : null,
    why: verdict ?? "",
  };
  return (await notices.add(n)) ? n : null;
}

// ---- A thread, whole

// A thread as Slack holds it now: every message the door would keep, the user's own too, oldest first. A channel's
// thread is its replies, a DM's or group DM's its last DM_LAST, which leave out the replies in a DM's own threads.
const DM_LAST = 30;

async function read(id: string): Promise<Message[]> {
  const [, channel, ts] = id.split(":");
  if (!login) await signIn();
  const r = ts ? await call("conversations.replies", { channel, ts, limit: "200" }) : await call("conversations.history", { channel, limit: String(DM_LAST) });
  return (r.messages as Message[]).filter((m) => !m.hidden && KEPT.has(m.subtype)).map((m) => ({ ...m, channel }))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

const whoOf = async (m: Message) => (m.user === login!.me ? "you" : fromApp(m) ? await appOf(m) : await nameOf(m.user ?? ""));

// The thread for a chat on its Inbox row and the gate (threads.ts, whole): who wrote each message, the user as "you",
// and its words with its files named.
export async function thread(id: string): Promise<{ who: string; at: number; text: string }[]> {
  return Promise.all((await read(id)).map(async (m) => ({ who: await whoOf(m), at: Number(m.ts), text: await textOf(m) })));
}

// The thread as its pane in the Inbox shows it, so that Slack's tab need not stay open ("inside inbox, with slack icon,
// with reply box", the user, 3 Nov; the desk issue "A chat from a Slack message, mail or event starts with its context",
// step 1.8): each message with its reactions, how many and whether one is the user's, and its files as cards, by name,
// kind and size, with their address in Slack; desk draws no image of them.
export interface Shown {
  id: string; // slack:<channel>:<ts>, as its notice's
  who: string;
  at: number;
  text: string; // its words, its files left to the cards
  link: string;
  mine: boolean;
  reactions: Reaction[];
  files: { name: string; kind: string; size: number | null; link: string }[];
}
export interface Reaction {
  name: string; // Slack's, such as +1 or eyes, with ::skin-tone-2 after it for a tone
  count: number;
  mine: boolean;
  image?: string; // the workspace's own emoji, its picture's address
}

export async function messages(id: string): Promise<Shown[]> {
  const kept = await read(id), custom = kept.some((m) => m.reactions?.length) ? await customEmoji() : new Map<string, string>();
  return Promise.all(kept.map(async (m) => ({
    id: `slack:${m.channel}:${m.ts}`,
    who: await whoOf(m),
    at: Number(m.ts),
    text: (await plain(rawOf(m))).slice(0, LONG),
    link: linkOf(m),
    mine: m.user === login!.me,
    reactions: (m.reactions ?? []).map((r) => {
      const image = custom.get(r.name.split("::")[0]);
      return { name: r.name, count: r.count ?? r.users?.length ?? 1, mine: Boolean(r.users?.includes(login!.me)), ...(image ? { image } : {}) };
    }),
    files: (m.files ?? []).filter((f) => f.mode !== "tombstone").map((f) => ({
      name: f.title || f.name || "a file", kind: f.pretty_type || f.filetype?.toUpperCase() || "File",
      size: typeof f.size === "number" ? f.size : null, link: f.permalink || linkOf(m),
    })),
  })));
}
const LONG = 20_000; // characters of one message's words, past which a message is no message

// The workspace's own emoji, by name, each its picture's address, an alias's too; read again after REFRESH.
let emoji: { at: number; byName: Map<string, string> } | null = null;
async function customEmoji(): Promise<Map<string, string>> {
  if (emoji && Date.now() - emoji.at < REFRESH) return emoji.byName;
  const listed = ((await call("emoji.list").catch(() => ({ emoji: {} }))).emoji ?? {}) as Record<string, string>;
  const byName = new Map<string, string>();
  for (const [name, url] of Object.entries(listed)) {
    const target = url.startsWith("alias:") ? listed[url.slice("alias:".length)] : url;
    if (target && !target.startsWith("alias:")) byName.set(name, target);
  }
  emoji = { at: Date.now(), byName };
  return byName;
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

// ---- Read in desk, read in Slack

// What you read in desk is read in Slack too, so that Slack's own badge, on your phone or a tab, says only what you have
// not seen ("Read in desk is read in Slack", the desk issue "A chat from a Slack message, mail or event starts with its
// context", step 1.7). Slack keeps one read mark per conversation, a DM's, a group DM's or a channel's, and one per
// thread you follow, and its own client moves them with conversations.mark and subscriptions.thread.mark, which take the
// user's session as they are (tried on 3 Nov: a thread's mark moved onto the one reply desk had shown). A mark only ever
// moves on, over the messages desk showed you (shown, by their notices' ids) and those that need no reading, your own,
// an edit or a join, and stops before the first other one, such as one the firewall dropped: Slack still says what you
// have not read. A channel's own mark moves only over the thread's first message, as a thread row shows no other.
//
// A thread's own row (whole) opens on the thread as Slack holds it (messages, above), so there every message up to the
// newest shown is seen, in the thread or the DM, though not the rest of the channel round a thread.
export async function markRead(thread: string, shown: Set<string>, whole = false) {
  const [, channel, ts] = thread.split(":");
  if (!login) await signIn();
  const newest = [...shown].map((id) => id.split(":")[2]).filter((t) => t && t !== ts).sort((a, b) => Number(b) - Number(a))[0];
  const inPane = (m: Message) => whole && newest != null && Number(m.ts) <= Number(newest);
  const seen = (m: Message, pane: boolean) => m.user === login!.me || Boolean(m.hidden) || !KEPT.has(m.subtype)
    || shown.has(`slack:${channel}:${m.ts}`) || (pane && inPane(m));
  // How far the run of messages after a mark is seen, oldest first: the last one seen, or null when the first is not.
  const reach = (after: string, list: Message[], pane: boolean) => {
    let to: string | null = null;
    for (const m of list.filter((x) => Number(x.ts) > Number(after)).sort((a, b) => Number(a.ts) - Number(b.ts))) {
      if (!seen(m, pane)) break;
      to = m.ts;
    }
    return to;
  };
  const upTo = ts ?? newest; // a DM's newest shown, or a channel thread's first message
  const mark = String((await call("conversations.info", { channel })).channel?.last_read ?? "0");
  if (upTo && Number(mark) < Number(upTo)) {
    const r = await call("conversations.history", { channel, oldest: mark, latest: upTo, inclusive: "true", limit: "200" });
    const to = r.has_more ? null : reach(mark, r.messages as Message[], !ts); // more than 200 unread: not all seen
    if (to) await call("conversations.mark", { channel, ts: to });
  }
  if (!ts || !newest) return;
  const r = await call("conversations.replies", { channel, ts, oldest: "0", limit: "1" });
  const root = (r.messages as (Message & { subscribed?: boolean; last_read?: string })[])[0];
  if (!root?.subscribed || !(Number(root.last_read ?? 0) < Number(newest))) return; // Slack counts no unread in a thread you do not follow
  const replies = await call("conversations.replies", { channel, ts, oldest: root.last_read ?? "0", limit: "200" });
  const to = reach(root.last_read ?? "0", (replies.messages as Message[]).filter((m) => m.ts !== ts && Number(m.ts) <= Number(newest)), true);
  if (to) await call("subscriptions.thread.mark", { channel, thread_ts: ts, ts: to, read: "1" });
}

// ---- What came while desk was not listening

// A desk that was down, a socket that closed, or one Slack refused: desk reads back what came meanwhile, from how far it
// last heard Slack (heard), kept in meta so that a restart reads back from where it stopped, BACK at most. Each
// conversation whose newest message is past the mark (client.counts, as Slack's own client asks) is read from there, and
// each thread the user follows with a reply past it (subscriptions.thread.getView: the threads they started, wrote in or
// were mentioned in, as Slack's Threads view lists them), and each channel thread attached to a chat, which the user
// may not follow in Slack (chats.ts, attached); each message goes through the door as one from the socket would, and
// one written already is left as it was (notices.add).
const BACK = 3 * 86400; // seconds: a weekend away
const OVERLAP = 60; // seconds read again before the mark, since Slack lists a message a little after its time
const EVERY = 60_000; // how often desk reads back while no socket is open
const HEARD = "slack heard";

async function heard(): Promise<number | null> {
  const r = await sql().query<{ value: string }>("select value from meta where name = $1", [HEARD]);
  return r.rows[0] ? Number(r.rows[0].value) : null;
}

// Slack heard up to this time, in seconds; a mark never goes back.
async function hear(at: number) {
  await sql().query(`insert into meta values ($1, $2) on conflict (name) do update
    set value = greatest(meta.value::double precision, excluded.value::double precision)::text`, [HEARD, String(at)]);
}

let reading: Promise<number> | null = null;

// Reads back from the mark to now, once at a time; how many messages it wrote.
function readBack(): Promise<number> {
  reading ??= (async () => {
    try {
      const began = Date.now() / 1000;
      const from = String(Math.max((await heard()) ?? began, began - BACK) - OVERLAP);
      const take_ = (m: Message, channel: string) => take({ ...m, type: "message", channel });
      let written = 0;
      const counts = await call("client.counts", {});
      for (const c of [...(counts.channels ?? []), ...(counts.mpims ?? []), ...(counts.ims ?? [])] as { id: string; latest?: string; mention_count?: number }[]) {
        if (!(Number(c.latest) > Number(from)) || (places.get(c.id)?.nonWork && !c.mention_count)) continue; // a non-work one only for an @you
        const got: Message[] = [];
        let cursor = "";
        do {
          const r = await call("conversations.history", { channel: c.id, oldest: from, limit: "200", cursor });
          got.push(...r.messages);
          cursor = r.response_metadata?.next_cursor || "";
        } while (cursor);
        for (const m of got.reverse()) if (await take_(m, c.id)) written++; // oldest first, as they came
      }
      const followed = (await call("subscriptions.thread.getView", { limit: "50" })).threads as { root_msg?: Message & { latest_reply?: string } }[];
      const read = new Set<string>();
      for (const { root_msg: root } of followed ?? []) {
        if (!root?.channel || !(Number(root.latest_reply) > Number(from))) continue; // a non-work one's: the door keeps an @you
        const r = await call("conversations.replies", { channel: root.channel, ts: root.thread_ts ?? root.ts, oldest: from, limit: "200" });
        read.add(`slack:${root.channel}:${root.thread_ts ?? root.ts}`);
        for (const m of r.messages as Message[]) if (m.ts !== root.ts && (await take_(m, root.channel))) written++;
      }
      for (const id of chats.attached()) {
        const [, channel, ts] = id.split(":");
        if (!id.startsWith("slack:") || !ts || read.has(id)) continue; // a DM's came with client.counts
        const r = await call("conversations.replies", { channel, ts, oldest: from, limit: "200" }).catch((e) => {
          console.error(`slack: reading back an attached thread, ${e.message}`); // its channel left, or the thread deleted
          return { messages: [] };
        });
        for (const m of r.messages as Message[]) if (m.ts !== ts && (await take_(m, channel))) written++;
      }
      await hear(began);
      return written;
    } finally {
      reading = null;
    }
  })();
  return reading;
}

// ---- The socket

let live = false; // a socket is open and Slack said hello on it
let polled = false; // whether the log said desk reads back each minute, since a socket last opened

// One socket's life: signed in, the places read, rtm.connect's socket open until it closes. Resolves when it does.
// Once Slack says hello, desk reads back what came since it last heard Slack, and marks it heard as the socket lives.
async function session() {
  if (!login) await signIn();
  await loadPlaces();
  const { url } = await call("rtm.connect");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url, { headers: { cookie: login!.cookie, "user-agent": UA } });
    socket = ws;
    let heardAt = Date.now(), id = 0, queue = Promise.resolve();
    const ping = setInterval(() => {
      if (Date.now() - heardAt > QUIET) return ws.terminate();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++id, type: "ping" }));
      if (live) void hear(heardAt / 1000).catch((e) => console.error("slack: keeping how far it heard,", e.message));
    }, 30_000);
    const refresh = setInterval(() => void loadPlaces().catch((e) => console.error("slack: reading the channels,", e.message)), REFRESH);
    ws.on("message", (data) => {
      heardAt = Date.now();
      let m: Message;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.type === "hello") {
        live = true;
        polled = false;
        const work = [...places.values()].filter((p) => p.kind === "channel" && !p.nonWork).length;
        console.log(`slack: connected as ${login?.handle}, ${work} work channels`);
        void readBack().then((n) => { if (n) console.log(`slack: read back ${n} that came while desk was not listening`); },
          (e) => console.error(`slack: reading back, ${e.message}`));
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
      live = false;
      if (!stopped) console.log(`slack: the socket closed (${code})`);
      resolve();
    });
  });
}

let polling: ReturnType<typeof setInterval> | null = null;

// Keeps a socket open while desk runs: after one closes, the next opens 5 s later, the wait doubling up to 5 minutes
// while they keep failing, and back to 5 s after one that lasted; a login that ended is tried again each minute, so that
// one made again in Chrome is picked up within the minute. While no socket is open but the login holds, as when Slack
// refuses the socket, desk reads back what came each minute instead.
export function start() {
  polling = setInterval(() => {
    if (stopped || live || !login || reading) return;
    if (!polled) console.log("slack: no socket, reading back each minute until one opens");
    polled = true;
    readBack().then((n) => { if (n) console.log(`slack: read back ${n}`); }, (e) => console.error(`slack: reading back, ${e.message}`));
  }, EVERY);
  void (async () => {
    let wait = 5_000;
    while (!stopped) {
      const began = Date.now();
      let signedOut = false;
      try {
        await session();
      } catch (e) {
        signedOut = e instanceof SignedOut;
        console.error(`slack: ${(e as Error).message}`);
      }
      if (Date.now() - began > 5 * 60_000) wait = 5_000;
      await new Promise((r) => setTimeout(r, signedOut ? EVERY : wait));
      wait = Math.min(wait * 2, 5 * 60_000);
    }
  })();
}

export function stop() {
  stopped = true;
  if (polling) clearInterval(polling);
  socket?.close();
}

// For a script trying the door on a channel's history: signs in and reads the places, as a socket's session does.
export async function ready() {
  if (!login) await signIn();
  await loadPlaces();
  return { places, call };
}
