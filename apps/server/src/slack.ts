// A Slack message the user tags with 🐧 becomes an issue in Triage, and desk's agent reads its thread in a chat of its
// own before the user opens it. The user, 17 Oct: "human has to decide, by tagging with emoji", after muse's sweep of
// every message (1 to 14 Oct) made "a lot of noise". desk only reads Slack ("read only", the user, 17 Oct): it posts
// nothing.
//
// The tag links the thread to its issue, and every later message in it goes to that issue's session ("when i tag a
// thread, it'll receive all messages for that thread", the user, 19 Oct). Messages come in runs ("there are a lot of
// DMs that don't go in a single msg", the user, 19 Oct), so desk gathers a thread's new messages until it has been
// quiet for QUIET seconds and hands them on together, which wakes the agent once per run, not once per line.
//
// Slack pushes each reaction and message to desk the moment it is made, over Socket Mode: a WebSocket desk opens with
// the desk app's app-level token ("i don't want a poll each minute. it should feel instant", the user, 17 Oct; "how
// about letting the slack pushes us?", 19 Oct). Each time the connection opens, desk lists the user's latest reactions
// and reads each linked thread since what it last handed on, so what came while desk was down or the laptop slept
// comes in then. Each tagged message is filed once, and a tag in a thread whose issue is still open files nothing
// more, since that issue's chat reads the whole thread.
import { join } from "node:path";
import * as chats from "./chats.ts";
import { DATA_DIR, PORT } from "./config.ts";
import * as copies from "./copies.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";
import * as store from "./issues.ts";
import { CLOSED } from "./issues.ts";
import * as live from "./live.ts";
import { run } from "./proc.ts";
import { fill, SLACK_PROMPT, SLACK_REPLY_PROMPT } from "./prompts.ts";
import { dayAndTime } from "./when.ts";

const TAG = "penguin"; // 🐧, desk's own mark (apps/web/public/favicon.svg), which the user had never reacted with
// The user's latest reactions, newest first. The user made 943 from 5 May to 17 Oct, so 100 reach back about two and a
// half weeks.
const LATEST = "100";
// In pass. Their gpg key has no passphrase (gpg-agent's keyinfo: protection C, 17 Oct), so reading them never asks.
const TOKEN = "dev/slack-ownego-user-token"; // the user's own token from the desk app (A0C4JSGDYUB, named muse until 17 Oct)
const APP_TOKEN = "dev/slack-ownego-app-level-token"; // the desk app's own, with connections:write, for Socket Mode
const RETRY = 30; // s before trying again when Slack cannot be reached
// s the clock may jump between two ticks of a 5 s timer before desk takes it for a sleep. After one the WebSocket may be
// dead without knowing it, so desk opens a new one.
const SLEPT = 30;
const QUIET = 60; // s a thread stays quiet before its new messages go on: a run of lines typed one after another
// The message subtypes someone wrote; the rest are edits, deletions, joins and the like
// (docs.slack.dev/reference/events/message).
const WRITTEN = new Set(["", "file_share", "thread_broadcast"]);
const STATE = join(DATA_DIR, "slack.json"); // where what desk handled was until 19 Oct, written out still (copies.ts)

// What desk handled, as the slack_filed and slack_threads tables hold it.
interface Seen {
  filed: string[]; // "<channel>/<ts>" of each tagged message already handled
  threads: Record<string, string>; // "<channel>/<thread ts>": the slug of the thread's issue
}

// Read slack.json back in, as desk starts, when a desk of an older branch changed it: what that desk filed counts as
// handled.
export async function open() {
  const text = await copies.changed(STATE);
  if (text === undefined) return;
  let seen: Seen = { filed: [], threads: {} };
  try {
    if (text) seen = { ...seen, ...JSON.parse(text) };
  } catch {
    // a file broken by hand counts as none
  }
  await db.write(async (tx) => {
    await tx.query("delete from slack_filed");
    await tx.query("delete from slack_threads");
    for (const message of new Set(seen.filed)) await tx.query("insert into slack_filed (message) values ($1)", [message]);
    for (const [thread, slug] of Object.entries(seen.threads)) await tx.query("insert into slack_threads values ($1, $2)", [thread, slug]);
  });
  await copies.taken(STATE, text);
}

async function handled(): Promise<Seen> {
  const filed = (await sql().query<{ message: string }>("select message from slack_filed order by seq")).rows.map((r) => r.message);
  const threads = (await sql().query<{ thread: string; slug: string }>("select thread, slug from slack_threads")).rows;
  return { filed, threads: Object.fromEntries(threads.map((r) => [r.thread, r.slug])) };
}

// The message is handled, and the thread's issue is the one filed from it, when one was.
async function handle(seen: Seen, key: string, thread: string | null) {
  await db.write(async (tx) => {
    await tx.query("insert into slack_filed (message) values ($1) on conflict do nothing", [key]);
    // Its chat reads the thread as it stands, so only what comes after goes on to it.
    if (thread) await tx.query("insert into slack_threads values ($1, $2, $3) on conflict (thread) do update set slug = excluded.slug, read = excluded.read", [thread, seen.threads[thread], stamp()]);
  });
  await copies.out(STATE, JSON.stringify({ filed: seen.filed, threads: seen.threads, ...copies.others(STATE, ["filed", "threads"]) }, null, 1) + "\n");
}

interface Message { ts: string; thread_ts?: string; user?: string; username?: string; subtype?: string; text?: string; reactions?: { name: string; users: string[] }[] }
interface Posted extends Message { channel: string }
interface Item { type: string; channel: string; message: Message }
interface Profile { display_name: string; real_name: string }
const nameOf = (p: Profile) => p.display_name || p.real_name;

// A Web API method, posted as a form: apps.connections.open answers a GET with insecure_request (17 Oct).
async function call<T>(token: string, method: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: new URLSearchParams(params) });
  const body = (await res.json()) as T & { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`Slack's ${method} answered ${body.error}`);
  return body;
}

async function secret(name: string): Promise<string> {
  const r = await run(["pass", "show", name], { timeout: 30 });
  if (r.code) throw new Error(`pass show ${name} failed: ${r.stderr.trim()}`);
  return r.stdout.split("\n")[0].trim();
}

let me = "", base = "", queue = Promise.resolve(), last = "";
const fail = (error: unknown) => { if (String(error) !== last) console.error("slack:", (last = String(error))); };
// One step at a time, so a catch-up and a pushed 🐧 never file the same message twice, nor hand on the same run.
const inTurn = (step: () => Promise<void>) => { queue = queue.then(step).then(() => { last = ""; }, fail); };

// Hold the Socket Mode connection for as long as desk runs. A failure that repeats, such as no network, is logged once.
export function connect() {
  base = `http://localhost:${PORT}`;
  let socket: WebSocket | null = null, tick = Date.now();
  const open = async () => {
    try {
      me ||= (await call<{ user_id: string }>(await secret(TOKEN), "auth.test")).user_id;
      const { url } = await call<{ url: string }>(await secret(APP_TOKEN), "apps.connections.open");
      const ws = (socket = new WebSocket(url));
      // Slack's envelopes: hello once connected, disconnect before it closes the link (every few hours, or warning
      // first), and events_api, which must be acknowledged with its envelope_id or Slack sends it again
      // (docs.slack.dev/apis/events-api/using-socket-mode).
      ws.onmessage = (m) => {
        const data = JSON.parse(String(m.data)), event = data.payload?.event;
        if (data.envelope_id) ws.send(JSON.stringify({ envelope_id: data.envelope_id }));
        if (data.type === "hello") {
          inTurn(look);
          inTurn(catchUp);
        } else if (data.type === "disconnect") ws.close();
        // Sent for reactions by anyone in a conversation the user can see (docs.slack.dev/reference/events/reaction_added);
        // look() keeps the user's own.
        else if (event?.type === "reaction_added" && event.reaction === TAG) inTurn(look);
        // Every message in every conversation the user is in (message.im, .mpim, .channels and .groups in the app's
        // manifest since 19 Oct); heard() keeps those in linked threads.
        else if (event?.type === "message") heard(event).catch(fail);
      };
      ws.onclose = () => {
        if (socket === ws) setTimeout(open, 1000);
      };
    } catch (error) {
      fail(error);
      setTimeout(open, RETRY * 1000);
    }
  };
  setInterval(() => {
    if (Date.now() - tick > SLEPT * 1000 && socket) {
      const old = socket;
      socket = null; // so its close starts nothing
      old.close();
      void open();
    }
    tick = Date.now();
  }, 5000);
  void open();
}

// File each newly tagged message, and start its chat.
async function look() {
  const token = await secret(TOKEN);
  const { items } = await call<{ items: Item[] }>(token, "reactions.list", { limit: LATEST, full: "true" }); // full: every reaction, so a busy message keeps its 🐧
  const seen = await handled();
  // Oldest first, so two tags in one thread file the first.
  for (const { type, channel, message: m } of items.reverse()) {
    const key = `${channel}/${m.ts}`;
    if (type !== "message" || seen.filed.includes(key) || !m.reactions?.some((x) => x.name === TAG && x.users.includes(me))) continue;
    const thread = threadOf({ ...m, channel });
    let i: store.Issue | null = null, author = "";
    if (!(await follow(seen.threads[thread]))) {
      author = await authorOf(token, m);
      i = await file(m, author, await permalink(token, channel, m.ts));
      seen.threads[thread] = i.slug;
    }
    seen.filed.push(key);
    // Saved before the chat starts, so a chat that fails to start leaves its issue filed once, not once a minute.
    await handle(seen, key, i ? thread : null);
    if (i) await startChat(i, m, author);
  }
}

// A message Slack pushed, or catchUp() read: into the run of its thread, when the thread is linked. The user's own
// messages wake nobody, as the user knows them.
async function heard(m: Posted) {
  if (!WRITTEN.has(m.subtype ?? "") || !m.user || m.user === me) return;
  const thread = threadOf(m);
  const linked = (await sql().query<{ read: string | null }>("select read from slack_threads where thread = $1", [thread])).rows[0];
  if (linked) gather(thread, m, linked.read);
}

const runs = new Map<string, { messages: Posted[]; timer?: NodeJS.Timeout }>();

function gather(thread: string, m: Posted, read: string | null) {
  const r = runs.get(thread) ?? { messages: [] };
  if (Number(m.ts) <= Number(read ?? 0) || r.messages.some((x) => x.ts === m.ts)) return; // catchUp() reads it again
  r.messages.push(m);
  clearTimeout(r.timer);
  r.timer = setTimeout(() => inTurn(() => handOn(thread)), QUIET * 1000);
  runs.set(thread, r);
}

// The run, once its thread has gone quiet, to the session of the thread's issue while that is open.
async function handOn(thread: string) {
  const ms = runs.get(thread)!.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  runs.delete(thread);
  const slug = (await sql().query<{ slug: string }>("select slug from slack_threads where thread = $1", [thread])).rows[0]?.slug;
  const i = await follow(slug);
  if (i) {
    const token = await secret(TOKEN), link = await permalink(token, ms[0].channel, ms[0].ts), names = new Map<string, string>();
    for (const m of ms) if (!names.has(m.user!)) names.set(m.user!, await authorOf(token, m));
    const quote = ms.map((m) => `${names.get(m.user!)}, ${when(m)}:\n\n${quoted(m)}`).join("\n\n");
    // Every linked issue has a session: the chat a 🐧 starts, which binding hands to the issue it binds.
    await live.send(i.session!, { text: fill(SLACK_REPLY_PROMPT, { link, quote }) });
  }
  await db.write(async (tx) => { await tx.query("update slack_threads set read = $2 where thread = $1", [thread, ms.at(-1)!.ts]); });
}

// What came while the connection was down: the new messages in each thread linked to an open issue.
async function catchUp() {
  const token = await secret(TOKEN);
  const linked = (await sql().query<{ thread: string; slug: string; read: string | null }>("select thread, slug, read from slack_threads")).rows;
  for (const { thread, slug, read } of linked) {
    if (!(await follow(slug))) continue;
    if (!read) {
      // Linked before 19 Oct, when nothing followed: from now on.
      await db.write(async (tx) => { await tx.query("update slack_threads set read = $2 where thread = $1", [thread, stamp()]); });
      continue;
    }
    const [channel, ts] = thread.split("/");
    const { messages } = await call<{ messages: Message[] }>(token, "conversations.replies", { channel, ts, oldest: read, limit: "200" });
    for (const m of messages) await heard({ ...m, channel });
  }
}

// The open issue a thread is linked to: its own, or the one its Triage issue was dropped as a duplicate of, which
// /api/issues/<slug>/work keeps as the link "/issue/<slug>". One step is enough: only a Triage issue is dropped so.
async function follow(slug: string | undefined, step = 0): Promise<store.Issue | null> {
  if (!slug || !(await store.exists(slug))) return null;
  const i = await store.load(slug);
  if (!CLOSED.has(i.state)) return i;
  return step === 0 && i.state === "dropped" && i.link?.startsWith("/issue/") ? follow(i.link.slice("/issue/".length), 1) : null;
}

// The issue in Triage, with the message as its Context and its link.
async function file(m: Message, author: string, link: string): Promise<store.Issue> {
  // The agent's title replaces this one once it has read the thread.
  const gist = (m.text ?? "").replace(LINK, "$2").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const title = `${author}: ${gist.length > 60 ? `${gist.slice(0, 60).trimEnd()}…` : gist || "a Slack message"}`;
  const i = store.blank(await store.newSlug(title), title);
  Object.assign(i, { state: "triage", link, body: `## Context\n\n${author} in Slack, ${when(m)}:\n\n${quoted(m)}\n\nThe user tagged it with 🐧 for desk: ${link}\n` });
  await store.save(i);
  console.log(`slack: filed ${i.slug} from ${link}`);
  return i;
}

// The chat that reads the message's thread, bound to its issue.
async function startChat(i: store.Issue, m: Message, author: string) {
  const message = fill(SLACK_PROMPT, { title: i.title, base, slug: i.slug, author, date: when(m), link: i.link!, quote: quoted(m) });
  const chat = await chats.newChat(base, { issue: i, message });
  await store.move(i, { session: chat.session }); // onto the issue as it is now, which the chat may have retitled already
}

const authorOf = async (token: string, m: Message) => m.user
  ? nameOf((await call<{ user: { profile: Profile } }>(token, "users.info", { user: m.user })).user.profile) : m.username ?? "a bot";
// reactions.list gives a message's permalink only sometimes: not for one posted through an app (17 Oct).
const permalink = async (token: string, channel: string, ts: string) =>
  (await call<{ permalink: string }>(token, "chat.getPermalink", { channel, message_ts: ts })).permalink;
const threadOf = (m: Posted) => `${m.channel}/${m.thread_ts ?? m.ts}`;
const stamp = () => (Date.now() / 1000).toFixed(6); // now, as Slack writes a message's ts
const when = (m: Message) => dayAndTime(new Date(Number(m.ts) * 1000));
// Slack writes a link with its label as <url|label> (docs.slack.dev/messaging/formatting-message-text), and a channel
// mention that carries its name as <#C123|name>.
const LINK = /<([^<>|]+)\|([^<>]+)>/g;
const quoted = (m: Message) => (m.text ?? "").trim().replace(LINK, (_, url: string, label: string) => (url.startsWith("#") ? `#${label}` : `[${label}](${url})`))
  .split("\n").map((line) => `> ${line}`).join("\n");
