// A reply to a Slack thread, DM or mail thread, as the user, and only on their word (the desk issue "desk as my
// notification center", 2 Nov: "Nothing goes to Slack or Gmail without your word. Claude shows the reply first; it is
// a message to people"). The thread's chat (threads.ts) puts Claude's reply on a card above the user's composer
// (PUT /api/threads/<id>/draft), where the user may edit it, and only their Send, from desk's page, posts it
// (POST /api/replies/<id>/send): Claude has no call that sends, since a thread holds other people's words, a mail a
// stranger's, and a line in one could ask it to. The user's own reply, written in the box under a thread's pane
// (POST /api/threads/<id>/send, from desk's page alone), or in the box above the composer of the chat that follows the
// thread, goes at once, with no card (yours). Each reply stays in the
// replies table, which the app holds, once sent: what desk sent as the user, when, and its link. A desk that connects
// to nothing, a test desk, keeps it and sends nothing.
import { randomUUID } from "node:crypto";
import { CONNECT } from "./config.ts";
import * as db from "./db.ts";
import { HttpError } from "./httperror.ts";
import * as mail from "./mail.ts";
import * as notices from "./notices.ts";
import * as slack from "./slack.ts";

export interface Reply {
  id: string;
  thread: string;
  source: "slack" | "mail";
  text: string;
  whom: string;
  state: "draft" | "sending" | "sent" | "failed" | "kept";
  at: number;
  sent: number | null;
  link: string;
  error: string;
}

const LONG = 20_000; // characters: Slack takes 40,000, and a reply this long is no reply
const asReply = (r: Record<string, unknown>): Reply => ({ ...(r as unknown as Reply), at: Number(r.at), sent: r.sent == null ? null : Number(r.sent) });
const now = () => Date.now() / 1000;

// Where the reply goes, as its card says it: in #imagenhub, in minhnt's thread; to chinhdt; in the group DM with a, b;
// to Talent team <talent@…>, which Gmail names, or on a test desk the mail's sender.
async function whomOf(thread: string, shown: notices.Notice[]): Promise<string> {
  const newest = shown[shown.length - 1];
  if (newest.source === "mail") {
    if (CONNECT) {
      try {
        return `to ${await mail.recipient(thread)}`;
      } catch (e) {
        console.error(`replies: reading a mail thread's sender, ${(e as Error).message}`);
      }
    }
    return `to ${newest.who}`;
  }
  if (newest.place === "DM") return `to ${newest.who}`;
  if (newest.place.startsWith("group DM")) return `in the ${newest.place}`;
  const [, channel, ts] = thread.split(":");
  const root = shown.find((n) => n.id === `slack:${channel}:${ts}`);
  return `in ${newest.place}, in ${root ? `${root.who}'s` : "the"} thread`;
}

// Claude's reply, put on the thread's card: the unsent one there takes the new text, or a new card comes.
export async function draft(thread: string, text: string): Promise<Reply> {
  const shown = await notices.ofThread(thread);
  if (!shown.length) throw new HttpError(404, "No such thread.");
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) throw new HttpError(400, "The reply is empty: send its text as the request's body.");
  if (body.length > LONG) throw new HttpError(400, `The reply is ${body.length} characters: keep it under ${LONG}.`);
  const whom = await whomOf(thread, shown);
  return db.write(async (tx) => {
    const open = (await tx.query<Record<string, unknown>>("select id from replies where thread = $1 and state in ('draft', 'failed')", [thread])).rows[0];
    const id = (open?.id as string | undefined) ?? `reply-${randomUUID().slice(0, 8)}`;
    const r = await tx.query<Record<string, unknown>>(
      `insert into replies (id, thread, source, text, whom, state, at) values ($1, $2, $3, $4, $5, 'draft', $6)
       on conflict (id) do update set text = excluded.text, whom = excluded.whom, state = 'draft', at = excluded.at, error = ''
       returning *`, [id, thread, shown[0].source, body, whom, now()]);
    return asReply(r.rows[0]);
  });
}

// The user's Send, with the text as they left it on the card: posted to Slack or sent from Gmail as them. One Send
// alone goes, though they press it twice. A refusal leaves the card, saying why, to send again.
export async function send(id: string, text: string): Promise<Reply> {
  const body = bodyOf(text);
  const taken = await db.write(async (tx) =>
    (await tx.query<Record<string, unknown>>("update replies set state = 'sending', text = $2, error = '' where id = $1 and state in ('draft', 'failed') returning *", [id, body])).rows[0]);
  if (!taken) {
    const r = (await db.sql().query<{ state: string }>("select state from replies where id = $1", [id])).rows[0];
    throw new HttpError(r ? 409 : 404, !r ? "No such reply." : r.state === "sending" ? "It is on its way." : "It went already.");
  }
  const reply = asReply(taken);
  const done = await deliver(reply.source, reply.thread, body);
  return db.write(async (tx) => asReply((await tx.query<Record<string, unknown>>(
    "update replies set state = $2, link = $3, error = $4, sent = $5 where id = $1 returning *",
    [id, done.state, done.link, done.error, done.state === "failed" ? null : now()])).rows[0]));
}

// The reply's text as it goes: its line ends Unix's, its ends trimmed, and not empty or past what a reply runs to.
function bodyOf(text: string) {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) throw new HttpError(400, "The reply is empty.");
  if (body.length > LONG) throw new HttpError(400, `The reply is ${body.length} characters: keep it under ${LONG}.`);
  return body;
}

// Posted to Slack or sent from Gmail as the user, or on a test desk kept; a refusal says why.
async function deliver(source: Reply["source"], thread: string, body: string): Promise<Pick<Reply, "state" | "link" | "error">> {
  let done: Pick<Reply, "state" | "link" | "error">;
  if (!CONNECT) done = { state: "kept", link: "", error: "" };
  else {
    try {
      done = { state: "sent", link: source === "slack" ? await slack.post(thread, body) : await mail.send(thread, body), error: "" };
    } catch (e) {
      done = { state: "failed", link: "", error: (e as Error).message };
    }
  }
  console.log(`replies: a ${source} reply ${done.state}${done.error ? `, ${done.error}` : ""}`); // its text and where stay out of the log
  return done;
}

// The user's own reply, from the box under the thread's pane or above the composer of the chat following it: it goes at
// once, as they wrote it, and is kept once it went, to show in the thread as from desk until Slack's copy comes back. A
// refusal keeps nothing, and the box keeps their text, with the reason, to send again ("we have to make the reply cheap
// enough, mechanically i suppose?", the user, 3 Nov). A draft of Claude's on the thread stays on its card.
//
// A thread a chat follows is answered from its cards in the chat too, after desk pruned its notices (notices.ts,
// KEEP_DAYS): then its source is its id's, and where it went is what the box said, as the page read it from the thread.
export async function yours(thread: string, text: string, said = ""): Promise<Reply> {
  const body = bodyOf(text);
  const shown = await notices.ofThread(thread);
  const source = shown[0]?.source ?? (thread.startsWith("mail:") ? "mail" : "slack");
  const done = await deliver(source, thread, body);
  if (done.state === "failed") throw new HttpError(502, `${source === "mail" ? "Gmail" : "Slack"} refused it: ${done.error}`);
  const whom = shown.length ? await whomOf(thread, shown) : said.slice(0, 200);
  return db.write(async (tx) => asReply((await tx.query<Record<string, unknown>>(
    `insert into replies (id, thread, source, text, whom, state, at, sent, link) values ($1, $2, $3, $4, $5, $6, $7, $7, $8) returning *`,
    [`reply-${randomUUID().slice(0, 8)}`, thread, source, body, whom, done.state, now(), done.link])).rows[0]));
}

// Discard on the card: an unsent reply goes.
export async function discard(id: string) {
  const gone = await db.write(async (tx) => (await tx.query("delete from replies where id = $1 and state in ('draft', 'failed')", [id])).affectedRows ?? 0);
  if (!gone) throw new HttpError(404, "No unsent reply by that id.");
}

// What the user sent in the thread from desk, oldest first, which its open row shows among the thread's messages.
export async function sentIn(thread: string): Promise<Reply[]> {
  return (await db.sql().query<Record<string, unknown>>("select * from replies where thread = $1 and state in ('sent', 'kept') order by sent", [thread])).rows.map(asReply);
}

// A reply desk stopped while it was on its way: whether it went is not known, so its card says so, to send again.
export async function recover() {
  await db.write((tx) => tx.query("update replies set state = 'failed', error = $1 where state = 'sending'",
    [`desk stopped while it was on its way: look in Slack or Gmail before you send it again`]));
}
