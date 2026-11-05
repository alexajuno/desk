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
//
// Each wake keeps what its turn cost, in Claude Code's own count, to learn whether a fixed rule could skip the noted
// ones for free: "we'll try to measure the cost and find if there is a mechanical mechanism (likely not because real
// world is too complex for fixed minute rule)" (the user, 3 Nov). Claude Code counts a session's spend as a running
// total, so a wake keeps the total before it and takes the difference once its turn ended (costed); GET /api/wakes sums
// them (report).
//
// Beside each wake, the gate (gate.ts) judges the same messages with the issue's document, Haiku saying wake or skip, in
// the shadow: the chat still wakes, and the gate's answer goes on the wake's row, for GET /api/wakes to set against the
// chat's verdict, so that it turns on only once it has skipped no now.
import { randomBytes } from "node:crypto";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { PORT } from "./config.ts";
import { sql } from "./db.ts";
import * as gate from "./gate.ts";
import * as store from "./issues.ts";
import * as notices from "./notices.ts";
import { fill, WAKE } from "./prompts.ts";
import * as threads from "./threads.ts";
import * as transcript from "./transcript.ts";
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
  spent: number | null; // the dollars its session had spent before it
  spentTokens: number | null; // and the tokens it had read
  cost: number | null; // the dollars its turn cost, once it ended
  tokens: number | null; // the tokens its turn read
  gate: gate.Gate | null; // the gate's answer on its messages, in the shadow; null until it came
  gateWhy: string;
  gateCost: number | null;
  gateMs: number | null;
}

const EVERY = 60_000; // the firewall's own beat: what came in a minute is one wake
const LAST = 30; // messages a wake carries at most, as after a weekend's read-back; the chat reads the rest itself
const STALL = 15 * 60; // seconds an open wake waits for a turn that never came, as when its host went, before it counts as later
const BASE = `http://127.0.0.1:${PORT}`;

const latest = new Map<string, Wake>(); // each session's newest wake
const num = (v: unknown) => (v == null ? null : Number(v));
const asWake = (r: Record<string, unknown>): Wake => ({
  id: String(r.id), chat: String(r.chat), session: String(r.session), thread: String(r.thread), messages: Number(r.messages), at: Number(r.at),
  before: num(r.before), verdict: (r.verdict as Verdict | null) ?? null, why: String(r.why ?? ""), answered: num(r.answered), error: String(r.error ?? ""),
  spent: num(r.spent), spentTokens: num(r.spent_tokens), cost: num(r.cost), tokens: num(r.tokens),
  gate: (r.gate as gate.Gate | null) ?? null, gateWhy: String(r.gate_why ?? ""), gateCost: num(r.gate_cost), gateMs: num(r.gate_ms),
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

// Whether the session's turn is a thread's: its last message a wake, with no word from the user since. Claude drafts a
// reply to a thread only when the user asks for one ("a lot of messages i have to react and reply within the chat. AI
// response is not a good choice", the user, 3 Nov), so desk refuses a draft in such a turn, holding the rule without
// trusting the prompt (app.ts, PUT /api/threads/<id>/draft).
export function inWake(session: string): boolean {
  const w = latest.get(session);
  return Boolean(w && !w.error && w.at > (turns.prompted(session) ?? 0));
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

// What the chat's session had spent before a wake: its host's word while its process runs, else what its transcript
// saved as its last process ended, which the wake's turn resumes from; nothing, for a session no process of which ended.
async function spentBefore(session: string): Promise<{ cost: number; tokens: number }> {
  const heard = turns.spent(session);
  if (heard && (await turns.hosting(session))) return heard;
  return transcript.saved(session) ?? heard ?? { cost: 0, tokens: 0 };
}

// A wake's own cost, once its turn ended: what its session spent since, by its host's word. Unchanged, its turn's result
// was not heard (a host from before 3 Nov, or a process that died mid-turn), and it waits; less, a /clear or a resume
// with no total saved started the count again, from the wake's turn.
async function costed(w: Wake) {
  const after = turns.spent(w.session);
  if (!after || w.spent === null || after.cost === w.spent) return;
  const cost = after.cost > w.spent ? after.cost - w.spent : after.cost;
  const tokens = after.tokens >= (w.spentTokens ?? 0) ? after.tokens - (w.spentTokens ?? 0) : after.tokens;
  await sql().query("update wakes set cost = $2, tokens = $3 where id = $1", [w.id, cost, tokens]);
  if (latest.get(w.session)?.id === w.id) latest.set(w.session, { ...latest.get(w.session)!, cost, tokens });
}

// Each chat's newest wake, once its turn ended: what it cost, and later, with nothing said, when it ended with no
// verdict; later too when its turn never came.
async function close() {
  for (const w of latest.values()) {
    if (w.error || turns.working(w.session)) continue;
    const ended = (turns.ended(w.session) ?? 0) > w.at;
    if (ended && w.cost === null) await costed(w);
    if (!w.verdict && (ended || now() - w.at > STALL)) await answer(w.id, "later", "");
  }
}

// The gate's answer on a wake's messages, kept on its row as it comes, the chat's turn going on meanwhile.
async function gated(w: Wake, chat: chats.Chat, carried: notices.Notice[]) {
  const g = await gate.judge(chat, carried);
  await sql().query("update wakes set gate = $2, gate_why = $3, gate_cost = $4, gate_ms = $5 where id = $1", [w.id, g.gate, g.why, g.cost, g.ms])
    .catch((e) => console.error(`wakes: keeping the gate's answer, ${e.message}`));
  const kept = latest.get(w.session);
  if (kept?.id === w.id) latest.set(w.session, { ...kept, gate: g.gate, gateWhy: g.why, gateCost: g.cost, gateMs: g.ms });
  if (g.gate === "failed") console.error(`wakes: the gate on ${w.id}, ${g.why}`);
}

// The chat woken with a thread's new messages, oldest first.
async function wake(chat: chats.Chat, carried: notices.Notice[]) {
  const id = `wake-${randomBytes(4).toString("hex")}`, thread = carried[0].thread, newest = carried[carried.length - 1];
  const was = await spentBefore(chat.session);
  const w: Wake = { id, chat: chat.id, session: chat.session, thread, messages: carried.length, at: now(),
    before: own(chat.session, turns.replied(chat.session)), verdict: null, why: "", answered: null, error: "",
    spent: was.cost, spentTokens: was.tokens, cost: null, tokens: null, gate: null, gateWhy: "", gateCost: null, gateMs: null };
  await sql().query(`insert into wakes (id, chat, session, thread, messages, at, before, spent, spent_tokens)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [w.id, w.chat, w.session, w.thread, w.messages, w.at, w.before, w.spent, w.spentTokens]);
  await notices.carried(carried.map((n) => n.id), id);
  latest.set(chat.session, w);
  void gated(w, chat, carried); // beside the wake, never in its way
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
  gate.keepSpare(chats.attached().size > 0);
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
    // An unsubscribed thread's wait, unwoken, until the user subscribes again (chats.ts, setSubscribed)
    const kept = mine.filter((n) => follows.has(n.thread) && !chat?.unsubscribed?.includes(n.thread));
    if (!chat || !kept.length || turns.working(chat.session) || asks.has(chat.session)) continue;
    const open = latest.get(chat.session);
    if (open && !open.verdict && !open.error) continue; // its turn has yet to start
    await wake(chat, kept.filter((n) => n.thread === kept[0].thread));
  }
}

// The wakes of the last days and their sums, by day, by chat and by verdict, for GET /api/wakes: what a wake costs, and
// which ones changed nothing for the user (noted), to read for a rule. A sum's cost and tokens are its costed wakes'.
export interface Sum {
  wakes: number;
  messages: number;
  costed: number; // the wakes whose cost is known
  cost: number; // dollars, Claude Code's estimate at list price
  tokens: number; // read, fresh or from the cache
  per_wake: number | null; // dollars, on average over the costed
}

const rounded = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function sum(list: Wake[]): Sum {
  const known = list.filter((w) => w.cost !== null), cost = known.reduce((n, w) => n + (w.cost ?? 0), 0);
  return { wakes: list.length, messages: list.reduce((n, w) => n + w.messages, 0), costed: known.length, cost: rounded(cost, 4),
    tokens: known.reduce((n, w) => n + (w.tokens ?? 0), 0), per_wake: known.length ? rounded(cost / known.length, 4) : null };
}

function by(list: Wake[], key: (w: Wake) => string): Map<string, Wake[]> {
  const groups = new Map<string, Wake[]>();
  for (const w of list) groups.set(key(w), [...(groups.get(key(w)) ?? []), w]);
  return groups;
}

// The gate in the shadow, set against the chat: each pair of the gate's answer and the chat's verdict, the wakes a skip
// would have saved (skipped, the chat noting them) and those it would have missed (skipped, the chat calling them now).
function gateSum(list: Wake[]) {
  const checked = list.filter((w) => w.gate !== null), costs = checked.filter((w) => w.gateCost !== null);
  const ms = checked.map((w) => w.gateMs ?? 0).sort((a, b) => a - b);
  const cost = costs.reduce((n, w) => n + (w.gateCost ?? 0), 0);
  const pairs = [...by(checked, (w) => `${w.gate} ${w.verdict ?? "open"}`)].map(([pair, ws]) => {
    const [gate, verdict] = pair.split(" ");
    return { gate, verdict, wakes: ws.length, chat_cost: sum(ws).cost };
  }).sort((a, b) => a.gate.localeCompare(b.gate) || a.verdict.localeCompare(b.verdict));
  const skipped = (verdict: string) => checked.filter((w) => w.gate === "skip" && w.verdict === verdict);
  return {
    checked: checked.length, failed: checked.filter((w) => w.gate === "failed").length,
    cost: rounded(cost, 4), per_check: costs.length ? rounded(cost / costs.length, 5) : null,
    ms_median: ms.length ? Math.round(ms[Math.floor(ms.length / 2)]) : null, ms_max: ms.length ? Math.round(ms[ms.length - 1]) : null,
    pairs, saved: { wakes: skipped("noted").length, cost: sum(skipped("noted")).cost }, missed: skipped("now").length,
  };
}

export const DAYS = 90; // the most a report reads back

export async function report(days: number) {
  const r = await sql().query<Record<string, unknown>>("select * from wakes where at >= $1 order by at desc", [now() - days * 86400]);
  const list = r.rows.map(asWake);
  const titled = (id: string) => (chats.exists(id) ? chats.load(id) : null);
  return {
    days,
    total: sum(list),
    by_day: [...by(list, (w) => new Date(w.at * 1000).toLocaleDateString("sv"))].map(([day, ws]) => ({ day, ...sum(ws) })),
    by_chat: [...by(list, (w) => w.chat)].map(([chat, ws]) => ({ chat, title: titled(chat)?.named || titled(chat)?.title || "", ...sum(ws) }))
      .sort((a, b) => b.cost - a.cost),
    by_verdict: [...by(list, (w) => w.verdict ?? "open")].map(([verdict, ws]) => ({ verdict, ...sum(ws) })),
    gate: gateSum(list),
    wakes: list.slice(0, 200).map((w) => ({ id: w.id, at: new Date(w.at * 1000).toISOString(), chat: w.chat, thread: w.thread, messages: w.messages,
      verdict: w.verdict, why: w.why, cost: w.cost === null ? null : rounded(w.cost, 4), tokens: w.tokens, error: w.error || undefined,
      gate: w.gate, gate_why: w.gateWhy, gate_cost: w.gateCost === null ? null : rounded(w.gateCost, 5), gate_ms: w.gateMs === null ? null : Math.round(w.gateMs) })),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export async function start() {
  const r = await sql().query<Record<string, unknown>>("select distinct on (session) * from wakes order by session, at desc");
  for (const row of r.rows) latest.set(String(row.session), asWake(row));
  notices.routeWith(async (thread) => (await chats.follower(thread))?.id ?? null);
  gate.keepSpare(chats.attached().size > 0); // warm by the first round's wake
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
  gate.stop();
}
