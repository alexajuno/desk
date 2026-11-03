// A thread's new messages wake the chat following it, which judges them knowing the issue, in the firewall's place: now
// (the issue's row comes up unread and pops up), later (unread, no pop-up) or noted (nothing for the user: the row
// stays as it was). "each msg wakes the chat with context is fine" (the user, 3 Nov), A of three, over the firewall
// judging first and the chat never waking; the desk issue "A chat from a Slack message, mail or event starts with its
// context, then we file the issue", step 1.5.
//
//   1. The door writes a message of a followed thread for its chat, unjudged (notices.ts, add), the user's own left out.
//   2. Each minute, desk gives each chat the new messages of one of its threads, as one message in a <desk-thread wake>
//      block, which the chat draws as the card of what came (transcript.ts). A chat at work, or asking the user
//      something, is left until its turn ends; what comes meanwhile joins the wake.
//   3. The chat ends that turn on POST /api/wakes/<id> with its verdict, in place of the call that sets the issue's
//      state; a turn that ends with none counts as later, the firewall's own rule when torn (prompts.ts, WAKE).
//
// A thread's message is not the user's: the host counts no message in a <…> block as their prompt (host.ts, said), so
// the user's last look, the issue's state (pages.ts, advance) and Auto (auto.ts) stay where they were, and the chat's
// row keeps its own last word to the user through the wake's turn (own), the news on it only by the verdict.
import { randomBytes } from "node:crypto";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { PORT } from "./config.ts";
import { sql } from "./db.ts";
import * as store from "./issues.ts";
import * as notices from "./notices.ts";
import { fill, WAKE } from "./prompts.ts";
import * as threads from "./threads.ts";
import * as turns from "./turns.ts";

export type Verdict = "now" | "later" | "noted";
export const VERDICTS = new Set<string>(["now", "later", "noted"]);

export interface Wake {
  id: string;
  chat: string;
  session: string;
  thread: string;
  messages: number;
  at: number; // seconds
  before: number | null;
  verdict: Verdict | null;
  why: string;
  answered: number | null;
  error: string;
}

const EVERY = 60_000; // the firewall's own beat: what came in a minute is one wake
const LAST = 30; // messages a wake carries at most, as after a weekend's read-back; the chat reads the rest itself
const STALL = 15 * 60; // seconds an open wake waits for a turn that never came, as when its host went, before it counts as later
const BASE = `http://127.0.0.1:${PORT}`;

const latest = new Map<string, Wake>(); // each session's newest wake
const asWake = (r: Record<string, unknown>): Wake => ({
  ...(r as unknown as Wake), messages: Number(r.messages), at: Number(r.at), before: r.before == null ? null : Number(r.before),
  answered: r.answered == null ? null : Number(r.answered),
});
const now = () => Date.now() / 1000;

// The chat's own last word to the user, in seconds, from the time its last turn replied: the time before a wake, while
// its last reply is a wake's, with no word from the user since the wake came. Its row reads this (pages.ts).
export function own(session: string, replied: number | null): number | null {
  const w = latest.get(session);
  if (!w || replied === null || w.error) return replied;
  return w.at > (turns.prompted(session) ?? 0) && replied >= w.at ? w.before : replied;
}

// When each wake's verdict came, by its id: the time of the row's news, now or later, rather than the message's, which
// may have waited out a long turn (store/inbox.ts pops up a now only while it is fresh).
export async function answeredAt(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const r = await sql().query<{ id: string; answered: unknown }>("select id, answered from wakes where id = any($1) and answered is not null", [ids]);
  return new Map(r.rows.map((w) => [w.id, Number(w.answered)]));
}

export class NoWake extends Error {}

// The chat's verdict on a wake, by its call; again when it changes its mind. The row hears it as the notices'.
export async function answer(id: string, verdict: Verdict, why: string): Promise<Wake> {
  const r = await sql().query<Record<string, unknown>>(`update wakes set verdict = $2, why = $3, answered = coalesce(answered, $4)
    where id = $1 returning *`, [id, verdict, why.trim().slice(0, 300), now()]);
  if (!r.rows[0]) throw new NoWake("No such wake: give the id its <desk-thread wake> block names.");
  const w = asWake(r.rows[0]);
  if (latest.get(w.session)?.id === w.id) latest.set(w.session, w);
  await notices.judgeWake(w.id, verdict, w.why);
  return w;
}

// The open wakes whose turn ended with no verdict, or never came: later, with nothing said.
async function close() {
  for (const w of latest.values()) {
    if (w.verdict || w.error || turns.working(w.session)) continue;
    if ((turns.ended(w.session) ?? 0) > w.at || now() - w.at > STALL) await answer(w.id, "later", "");
  }
}

// The chat woken with a thread's new messages, oldest first.
async function wake(chat: chats.Chat, carried: notices.Notice[]) {
  const id = `wake-${randomBytes(4).toString("hex")}`, thread = carried[0].thread, newest = carried[carried.length - 1];
  const w: Wake = { id, chat: chat.id, session: chat.session, thread, messages: carried.length, at: now(),
    before: own(chat.session, turns.replied(chat.session)), verdict: null, why: "", answered: null, error: "" };
  await sql().query(`insert into wakes (id, chat, session, thread, messages, at, before) values ($1, $2, $3, $4, $5, $6, $7)`,
    [w.id, w.chat, w.session, w.thread, w.messages, w.at, w.before]);
  await notices.carried(carried.map((n) => n.id), id);
  latest.set(chat.session, w);
  const shown = carried.slice(-LAST), left = carried.length - shown.length;
  const message = fill(WAKE, {
    id: thread, wake: id, count: carried.length === 1 ? "A new message" : `${carried.length} new messages`, kind: threads.kindOf(newest),
    where: newest.source === "mail" ? "Gmail" : "Slack", link: newest.link || "none kept",
    call: `curl -s "${BASE}/api/wakes/${id}" --json '{"verdict": "now", "why": "<one line>"}'`,
    read: `curl -s "${BASE}/api/threads/${encodeURIComponent(thread)}"`,
    thread: (left ? `(${left} earlier ones left out: read the thread whole for them)\n\n` : "") + threads.asText(shown),
  });
  try {
    await agents.tell(chat.session, message);
  } catch (e) {
    // Never lost: the row shows it as later, as a turn with no call would
    const error = (e as Error).message || "it failed";
    console.error(`wakes: waking ${chat.id}, ${error}`);
    await sql().query("update wakes set error = $2 where id = $1", [id, error]);
    latest.set(chat.session, { ...w, error });
    await answer(id, "later", "");
  }
}

// One round: each chat with new messages, idle and asking nothing, woken with those of one of its threads; those of a
// thread it no longer follows, let go, its chat deleted or a DM whose issue closed, go to the firewall for a row of
// their own.
async function round() {
  await close();
  const waiting = await notices.forChats();
  if (!waiting.length) return;
  const issues = await store.loadAll(), asks = await turns.asking();
  const byChat = new Map<string, notices.Notice[]>();
  for (const n of waiting) byChat.set(n.chat!, [...(byChat.get(n.chat!) ?? []), n]);
  for (const [id, mine] of byChat) {
    const chat = chats.exists(id) ? chats.load(id) : null;
    const follows = new Set(chat ? chats.follows(chat, issues) : []);
    const gone = mine.filter((n) => !follows.has(n.thread));
    if (gone.length) await notices.toFirewall(gone.map((n) => n.id));
    const kept = mine.filter((n) => follows.has(n.thread));
    if (!chat || !kept.length || turns.working(chat.session) || asks.has(chat.session)) continue;
    const open = latest.get(chat.session);
    if (open && !open.verdict && !open.error) continue; // its turn has yet to start
    await wake(chat, kept.filter((n) => n.thread === kept[0].thread));
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export async function start() {
  const r = await sql().query<Record<string, unknown>>("select distinct on (session) * from wakes order by session, at desc");
  for (const row of r.rows) latest.set(String(row.session), asWake(row));
  notices.routeWith(async (thread) => (await chats.follower(thread))?.id ?? null);
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await round();
    } catch (e) {
      console.error(`wakes: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, EVERY);
  // A turn that ended on a wake with no call counts as later at once, not a minute on
  turns.onChange((_sessions, ended) => {
    if (ended.some((s) => latest.has(s))) void close().catch((e) => console.error(`wakes: ${e.message}`));
  });
}

export function stop() {
  if (timer) clearInterval(timer);
}
