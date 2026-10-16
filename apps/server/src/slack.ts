// A Slack message the user tags with 🐧 becomes an issue in Triage, and desk's agent reads its thread in a chat of its
// own before the user opens it. The user, 17 Oct: "human has to decide, by tagging with emoji", after muse's sweep of
// every message (1 to 14 Oct) made "a lot of noise". desk only reads Slack ("read only", the user, 17 Oct): it posts
// nothing, and nothing in the thread syncs back once the issue is filed.
//
// Slack pushes each reaction to desk the moment it is added, over Socket Mode: a WebSocket desk opens with the desk
// app's app-level token ("i don't want a poll each minute. it should feel instant", the user, 17 Oct). Each time the
// connection opens, desk lists the user's latest reactions once, so a tag made while desk was down or the laptop slept
// comes in then. Each tagged message is filed once, and a tag in a thread whose issue is still open files nothing
// more, since that issue's chat reads the whole thread.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as chats from "./chats.ts";
import { DATA_DIR, PORT } from "./config.ts";
import * as store from "./issues.ts";
import { CLOSED } from "./issues.ts";
import { run } from "./proc.ts";
import { fill, SLACK_PROMPT } from "./prompts.ts";
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
const STATE = join(DATA_DIR, "slack.json");

interface Seen {
  filed: string[]; // "<channel>/<ts>" of each tagged message already handled
  threads: Record<string, string>; // "<channel>/<thread ts>": the slug of the thread's issue
}

interface Message { ts: string; thread_ts?: string; user?: string; username?: string; text?: string; reactions?: { name: string; users: string[] }[] }
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

// Hold the Socket Mode connection for as long as desk runs. A failure that repeats, such as no network, is logged once.
export function connect() {
  const base = `http://localhost:${PORT}`;
  let socket: WebSocket | null = null, last = "", looking = Promise.resolve(), tick = Date.now();
  const fail = (error: unknown) => { if (String(error) !== last) console.error("slack:", (last = String(error))); };
  // One look at a time, so a catch-up and a pushed 🐧 never file the same message twice.
  const lookNow = () => { looking = looking.then(() => look(base)).then(() => { last = ""; }, fail); };
  const open = async () => {
    try {
      const { url } = await call<{ url: string }>(await secret(APP_TOKEN), "apps.connections.open");
      const ws = (socket = new WebSocket(url));
      // Slack's envelopes: hello once connected, disconnect before it closes the link (every few hours, or warning
      // first), and events_api, which must be acknowledged with its envelope_id or Slack sends it again
      // (docs.slack.dev/apis/events-api/using-socket-mode).
      ws.onmessage = (m) => {
        const data = JSON.parse(String(m.data));
        if (data.envelope_id) ws.send(JSON.stringify({ envelope_id: data.envelope_id }));
        if (data.type === "hello") lookNow();
        else if (data.type === "disconnect") ws.close();
        // Sent for reactions by anyone in a conversation the user can see (docs.slack.dev/reference/events/reaction_added);
        // look() keeps the user's own.
        else if (data.payload?.event?.type === "reaction_added" && data.payload.event.reaction === TAG) lookNow();
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
export async function look(base: string) {
  const token = await secret(TOKEN);
  const me = (await call<{ user_id: string }>(token, "auth.test")).user_id;
  const { items } = await call<{ items: Item[] }>(token, "reactions.list", { limit: LATEST, full: "true" }); // full: every reaction, so a busy message keeps its 🐧
  const seen: Seen = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { filed: [], threads: {} };
  // Oldest first, so two tags in one thread file the first.
  for (const { type, channel, message: m } of items.reverse()) {
    const key = `${channel}/${m.ts}`;
    if (type !== "message" || seen.filed.includes(key) || !m.reactions?.some((x) => x.name === TAG && x.users.includes(me))) continue;
    const thread = `${channel}/${m.thread_ts ?? m.ts}`, open = seen.threads[thread];
    let i: store.Issue | null = null, author = "";
    if (!(open && (await store.exists(open)) && !CLOSED.has((await store.load(open)).state))) {
      author = m.user ? nameOf((await call<{ user: { profile: Profile } }>(token, "users.info", { user: m.user })).user.profile) : m.username ?? "a bot";
      // reactions.list gives a message's permalink only sometimes: not for one posted through an app (17 Oct).
      const { permalink } = await call<{ permalink: string }>(token, "chat.getPermalink", { channel, message_ts: m.ts });
      i = await file(m, author, permalink);
      seen.threads[thread] = i.slug;
    }
    seen.filed.push(key);
    // Written before the chat starts, so a chat that fails to start leaves its issue filed once, not once a minute.
    writeFileSync(STATE, JSON.stringify(seen, null, 1) + "\n", "utf8");
    if (i) await startChat(i, m, author, base);
  }
}

// The issue in Triage, with the message as its Context and its link.
async function file(m: Message, author: string, link: string): Promise<store.Issue> {
  const text = (m.text ?? "").trim();
  // Slack writes a mention or a link as <...>; the agent's title replaces this one once it has read the thread.
  const gist = text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const title = `${author}: ${gist.length > 60 ? `${gist.slice(0, 60).trimEnd()}…` : gist || "a Slack message"}`;
  const i = store.blank(await store.newSlug(title), title);
  Object.assign(i, { state: "triage", link, body: `## Context\n\n${author} in Slack, ${when(m)}:\n\n${quoted(m)}\n\nThe user tagged it with 🐧 for desk: ${link}\n` });
  await store.save(i);
  console.log(`slack: filed ${i.slug} from ${link}`);
  return i;
}

// The chat that reads the message's thread, bound to its issue.
async function startChat(i: store.Issue, m: Message, author: string, base: string) {
  const message = fill(SLACK_PROMPT, { title: i.title, base, slug: i.slug, author, date: when(m), link: i.link!, quote: quoted(m) });
  const chat = await chats.newWindowChat(base, { issue: i, message });
  await store.move(i, { session: chat.session }); // onto the issue as it is now, which the chat may have retitled already
}

const when = (m: Message) => dayAndTime(new Date(Number(m.ts) * 1000));
const quoted = (m: Message) => (m.text ?? "").trim().split("\n").map((line) => `> ${line}`).join("\n");
