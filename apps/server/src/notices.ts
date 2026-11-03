// What comes in from Slack and Gmail, each message or mail a notice, with the firewall's verdict on it: now (it pops
// up), later (it waits in the Inbox, unread) or dropped. desk is the user's notification center: "a layer in desk handles
// noti filtering, that only when sth worth notified about that it pops up and carry it on with me" (the user, 2 Nov;
// the desk issue "desk as my notification center"). The connectors write a notice as it comes, the firewall judges it,
// and the Inbox shows one row per thread holding a notice now or later (pages.ts, threadRow), or, for a thread a chat
// follows, its newest such notice on the chat's row (withNews).
//
// A thread a chat follows skips the firewall: its notice goes to that chat, which judges it knowing the issue, as now,
// later or noted (nothing for the user), once desk wakes it with the thread's new messages (wakes.ts).
//
// What a rule drops at the door (an edit, a join, a reaction, a non-work channel's but an @you) is never written. Every
// mail is, the ordinary ones too, since bin/mail-daily lists each mail of the day with its topic. A notice is kept
// KEEP_DAYS, enough for bin/mail-daily after a few days off. The app holds the Inbox's rows, not these: it asks for a thread's notices
// when one is opened.
import { sql } from "./db.ts";

export type Verdict = "now" | "later" | "dropped" | "noted"; // noted: a chat's, for a message with nothing for the user

export interface Notice {
  id: string; // slack:<channel>:<ts>, or mail:<Gmail's id>
  source: "slack" | "mail";
  thread: string; // its DM, Slack thread or mail thread
  place: string; // #imagenhub, a DM, a group DM, mail
  who: string;
  text: string;
  link: string;
  at: number; // seconds
  verdict: Verdict | null;
  why: string;
  chat?: string | null; // the chat following its thread, which judges it in the firewall's place (wakes.ts)
  wake?: string | null; // the wake that gave it to that chat
}

const KEEP_DAYS = 14;

const asNotice = (r: Record<string, unknown>): Notice => ({ ...(r as unknown as Notice), at: Number(r.at) });

// What the Inbox hears when a notice gets its verdict, now or later: server.ts tells the apps, whose frame writes the
// Inbox's rows again (pages.ts).
let judged = () => {};
export const onJudged = (fn: () => void) => { judged = fn; };

// The chat following a thread, by id, or null: wakes.ts says, once it starts.
let followerOf: (thread: string) => Promise<string | null> = async () => null;
export const routeWith = (fn: typeof followerOf) => { followerOf = fn; };

// A notice as it comes; one already written, as a socket's reconnect may send again, is left as it was. One in a thread
// a chat follows goes to the chat unjudged, whatever verdict a rule at the door gave it. True when new.
export async function add(n: Omit<Notice, "verdict" | "why"> & Partial<Pick<Notice, "verdict" | "why">>): Promise<boolean> {
  const chat = await followerOf(n.thread);
  const [verdict, why] = chat ? [null, ""] : [n.verdict ?? null, n.why ?? ""];
  const r = await sql().query(
    `insert into notices (id, source, thread, place, who, text, link, at, verdict, why, chat) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (id) do nothing`,
    [n.id, n.source, n.thread, n.place, n.who, n.text, n.link, n.at, verdict, why, chat]);
  const added = (r.affectedRows ?? 0) > 0;
  if (added && verdict) judged();
  return added;
}

export async function judge(id: string, verdict: Verdict, why: string) {
  await sql().query("update notices set verdict = $2, why = $3 where id = $1", [id, verdict, why]);
  judged();
}

// The whys slack.ts's door writes on what a rule lets through as now: the Inbox's line shows such a message's own text.
export const RULED = new Set(["a DM", "a group DM", "@you", "a reply in your thread"]);

// The notices the Inbox shows: now or later, a mail as a Slack message, and a dropped one never. Until 3 Nov a mail
// judged later waited for the 08:00 report (bin/mail-daily), up to a day: "later in inbox but no popup is good enough"
// (the user, 3 Nov, of a YC co-founder invite that came at 10:53). Only now pops up (store/inbox.ts).
const SHOWN = "verdict in ('now', 'later')";

// Each thread holding a notice the Inbox shows, by its newest such notice: one Inbox row each.
export async function threads(): Promise<Notice[]> {
  return (await sql().query<Record<string, unknown>>(`select distinct on (thread) * from notices where ${SHOWN}
    order by thread, at desc, id desc`)).rows.map(asNotice);
}

// Which of these ids are written already, as a poll asks before it fetches what it has not seen.
export async function known(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await sql().query<{ id: string }>("select id from notices where id = any($1)", [ids]);
  return new Set(r.rows.map((x) => x.id));
}

// When the newest notice of one source was sent, or null when none is written.
export async function newest(source: Notice["source"]): Promise<number | null> {
  const r = await sql().query<{ at: unknown }>("select max(at) as at from notices where source = $1", [source]);
  return r.rows[0]?.at == null ? null : Number(r.rows[0].at);
}

// The notices the firewall has yet to judge, oldest first: those of a thread a chat follows are the chat's.
export async function unjudged(): Promise<Notice[]> {
  return (await sql().query<Record<string, unknown>>("select * from notices where verdict is null and chat is null order by at")).rows.map(asNotice);
}

// The notices waiting to wake the chat following their thread, oldest first.
export async function forChats(): Promise<Notice[]> {
  return (await sql().query<Record<string, unknown>>("select * from notices where chat is not null and wake is null and verdict is null order by at")).rows.map(asNotice);
}

// The notices given to a chat in a wake.
export async function carried(ids: string[], wake: string) {
  await sql().query("update notices set wake = $2 where id = any($1)", [ids, wake]);
}

// The notices back to the firewall, as their chat no longer follows their thread.
export async function toFirewall(ids: string[]) {
  await sql().query("update notices set chat = null where id = any($1) and wake is null", [ids]);
}

// The chat's verdict on the notices a wake carried, again each time it changes its mind.
export async function judgeWake(wake: string, verdict: Verdict, why: string) {
  await sql().query("update notices set verdict = $2, why = $3 where wake = $1", [wake, verdict, why]);
  judged();
}

// A thread's notices, oldest first, as its Inbox row opens them: all but the dropped ones, the ones still unjudged too.
export async function ofThread(thread: string): Promise<Notice[]> {
  return (await sql().query<Record<string, unknown>>(`select * from notices where thread = $1 and verdict is distinct from 'dropped'
    order by at`, [thread])).rows.map(asNotice);
}

// The thread a notice is in, by the notice's id, or null when desk never wrote it down or pruned it.
export async function threadOf(id: string): Promise<string | null> {
  return (await sql().query<{ thread: string }>("select thread from notices where id = $1", [id])).rows[0]?.thread ?? null;
}

// The notices of one source that came in since a time, oldest first, as bin/mail-daily reads the day's mail.
export async function since(source: Notice["source"], at: number): Promise<Notice[]> {
  return (await sql().query<Record<string, unknown>>("select * from notices where source = $1 and at >= $2 order by at", [source, at])).rows.map(asNotice);
}

export async function prune() {
  await sql().query("delete from notices where at < $1", [Date.now() / 1000 - KEEP_DAYS * 86400]);
}
