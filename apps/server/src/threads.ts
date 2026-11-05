// A chat from a Slack thread's, DM's or mail thread's Inbox row (pages.ts, threadRow): writing in the open row starts a
// chat with Claude on it, which carries the thread whole, and only the user sees ("a layer in desk handles noti
// filtering, that only when sth worth notified about that it pops up and carry it on with me", the user, 2 Nov; the
// desk issue "desk as my notification center"). It is desk's agent chat, named after the thread, which files its issue
// in Triage from its first reply, its Context quoting the message, then the user (3 Nov; chats.ts, cameIn); the row
// opens on it from then on. The chat follows the thread, with no end, and any other thread it attaches (idOf, below).
// One started before 3 Nov is a bare Chat, and stays one.
//
// desk reads the thread again from Slack or Gmail as the chat starts, the user's own messages too, since the notices
// hold only what the door let in; the chat reads it again on GET /api/threads/<id> as the talk goes on. A desk that
// connects to nothing, a test desk, gives the notices.
import * as chats from "./chats.ts";
import { CONNECT, PORT } from "./config.ts";
import { HttpError } from "./httperror.ts";
import type * as inbox from "./inbox.ts";
import * as mail from "./mail.ts";
import * as notices from "./notices.ts";
import { fill, ON_THREAD } from "./prompts.ts";
import * as replies from "./replies.ts";
import * as slack from "./slack.ts";

export interface Said {
  who: string;
  at: number; // seconds
  text: string;
}

const BASE = `http://127.0.0.1:${PORT}`;
export const IS = /^(slack|mail):[\w.:-]+$/;

// A thread's row's title, as the Inbox lists it: a channel by its name, a DM by its sender, a group DM by who is in
// it, a mail by its subject.
export function titleOf(n: notices.Notice) {
  if (n.source === "mail") return n.text.split("\n")[0] || "(no subject)";
  return n.place === "DM" ? n.who : n.place.replace(/^group DM with /, "");
}

// What the thread is, for Claude: "the Slack thread in #imagenhub", "chinhdt's Slack DM", "the mail thread “Interview”".
export function kindOf(n: notices.Notice) {
  if (n.source === "mail") return `the mail thread “${titleOf(n)}”${n.place === "mail" ? "" : n.place.slice(4)}`;
  if (n.place === "DM") return `${n.who}'s Slack DM to the user`;
  return n.place.startsWith("group DM") ? `the Slack ${n.place}` : `the Slack thread in ${n.place}`;
}

// The thread as it stands, oldest first: from Slack or Gmail, else from desk's notices.
export async function whole(thread: string): Promise<Said[]> {
  if (CONNECT) {
    try {
      return thread.startsWith("slack:") ? await slack.thread(thread) : await mail.thread(thread);
    } catch (e) {
      console.error(`threads: reading a ${thread.split(":")[0]} thread, ${(e as Error).message}`); // its name and text stay out of the log
    }
  }
  return (await notices.ofThread(thread)).map(({ who, at, text }) => ({ who, at, text }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
const when = (at: number) => {
  const d = new Date(at * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

// The thread as Claude reads it: each message under who wrote it and when.
export const asText = (said: Said[]) => said.map((s) => `${s.who}, ${when(s.at)}:\n${s.text.trim()}`).join("\n\n");

// The chat on the thread, started with the user's first words, which the thread's notice and the thread itself follow
// in a block the chat's panel draws as its card (transcript.ts, Came). The chat follows the thread from its start
// (chats.ts, onThread).
export async function startChat(thread: string, text: string): Promise<chats.Chat> {
  if (!IS.test(thread)) throw new HttpError(404, "No such thread.");
  if (!text.trim()) throw new HttpError(400, "Write something to start the chat.");
  const shown = await notices.ofThread(thread);
  if (!shown.length) throw new HttpError(404, "No such thread.");
  if (await chats.follower(thread)) throw new HttpError(409, "This thread has a chat already.");
  const newest = shown[shown.length - 1];
  const judged = [...shown].reverse().find((n) => n.verdict === "now") ?? [...shown].reverse().find((n) => n.verdict === "later");
  const message = fill(ON_THREAD, {
    text: text.trim(), id: thread, kind: kindOf(newest), verdict: judged?.verdict ?? "later", why: judged?.why || "no reason given",
    where: newest.source === "mail" ? "Gmail" : "Slack", link: newest.link || "none kept", read: `curl -s "${BASE}/api/threads/${encodeURIComponent(thread)}"`,
    draft: `curl -s "${BASE}/api/threads/${encodeURIComponent(thread)}/draft" -X PUT --data-binary @<the file>`,
    markup: newest.source === "mail" ? "the mail's plain text, its greeting and sign-off too" : "Slack's markup: *bold*, _italic_, <url|text> for a link, and a person as @ and their name as the thread shows it",
    whom: newest.source === "mail" ? "from their Gmail to the thread's last sender, under its subject with Re:" : newest.place === "DM" || newest.place.startsWith("group DM") ? "as them, in the DM" : "as them, in the thread",
    thread: asText(await whole(thread)),
  });
  return chats.onThread(thread, titleOf(newest), message);
}

// ---- The thread in its pane

// What the thread's pane in the Inbox lists (pages.ts, threadPage), oldest first. A Slack thread is read whole from
// Slack, so that the pane shows what Slack's tab would: the user's own messages, reactions and files too (slack.ts,
// messages). Each keeps its notice's verdict and why, for the line on why it reached you, and a notice Slack's read
// leaves out, a reply in a DM's own thread, stays. What the user sent from desk is Slack's copy, said to be from desk,
// or, until Slack has it, desk's (replies.ts). A mail thread, and a Slack one Slack does not answer, is its notices.
export interface Message extends Omit<slack.Shown, "link"> {
  source: "slack" | "mail";
  place: string;
  link: string;
  verdict: notices.Verdict | null;
  why: string;
  desk: boolean; // sent from desk
}

export async function pane(thread: string): Promise<Message[]> {
  const found = await notices.ofThread(thread);
  if (!found.length) return [];
  const { source, place } = found[found.length - 1];
  const byId = new Map(found.map((n) => [n.id, n]));
  const sent = await replies.sentIn(thread);
  const tsOf = (link: string) => link.match(/\/p(\d{10})(\d{6})/)?.slice(1).join(".");
  const sentAt = new Set(sent.map((r) => tsOf(r.link)).filter(Boolean));
  let read: slack.Shown[] | null = null;
  if (source === "slack" && CONNECT) {
    try {
      read = await slack.messages(thread);
    } catch (e) {
      console.error(`threads: reading a Slack thread for its pane, ${(e as Error).message}`);
    }
  }
  const asMessage = (n: notices.Notice): Message => ({ id: n.id, source: n.source, place: n.place, who: n.who, text: n.text, link: n.link,
    at: n.at, mine: n.who === "you", verdict: n.verdict, why: n.why, desk: false, ...(madeUp.get(n.id) ?? { reactions: [], files: [] }) });
  const all: Message[] = read
    ? read.map((m) => {
      const n = byId.get(m.id);
      return { ...m, source, place, verdict: n?.verdict ?? null, why: n?.why ?? "", desk: sentAt.has(m.id.split(":")[2]) };
    })
    : found.map(asMessage);
  if (read) {
    const have = new Set(read.map((m) => m.id)), oldest = read[0]?.at ?? Infinity;
    all.push(...found.filter((n) => !have.has(n.id) && n.at >= oldest).map(asMessage));
  }
  const have = new Set(all.map((m) => m.id.split(":")[2]));
  for (const r of sent) {
    if (read && have.has(tsOf(r.link) ?? "")) continue;
    all.push({ id: r.id, source: r.source, place, who: "you", text: r.text, link: r.link, at: r.sent ?? r.at, mine: true, verdict: null, why: "",
      desk: true, reactions: [], files: [] });
  }
  return all.sort((a, b) => a.at - b.at);
}

// Your name in Slack, for your avatar's initial in the pane; none for a mail thread or on a test desk.
export const myName = async (thread: string) => (CONNECT && thread.startsWith("slack:") ? slack.myName().catch(() => "") : "");

// The workspace's own emoji, for the pane's picker; none on a test desk.
export const workspaceEmoji = async () => (CONNECT ? slack.workspaceEmoji().catch(() => ({})) : {});

// A test desk's made-up reactions and files, by notice, as POST /api/notices gives them (app.ts): it reads no Slack.
const madeUp = new Map<string, Pick<slack.Shown, "reactions" | "files">>();
export function makeUp(id: string, extras: Pick<slack.Shown, "reactions" | "files">) {
  madeUp.set(id, extras);
}

// Your reaction on a message in the pane, added (on) or taken back, as you in Slack (slack.ts, react). Only your click
// in desk's page sends it (app.ts): Claude has no call that acts in Slack. A test desk, which reaches no Slack, changes
// its made-up reactions instead, and logs what it would have done.
export async function react(message: string, name: string, on: boolean) {
  if (CONNECT) return slack.react(message, name, on);
  const extras = madeUp.get(message) ?? { reactions: [], files: [] };
  const r = extras.reactions.find((x) => x.name === name);
  if (!r && on) extras.reactions.push({ name, count: 1, mine: true });
  else if (r && r.mine !== on) Object.assign(r, { count: r.count + (on ? 1 : -1), mine: on });
  madeUp.set(message, { ...extras, reactions: extras.reactions.filter((x) => x.count > 0) });
  console.log(`threads: would ${on ? "add" : "take back"} :${name}: on ${message} in Slack`);
}

// ---- A thread a chat attaches or lets go of (chats.ts, follow), by the chat's own call to desk's API on the user's
// word, such as "minhnt opened another thread about it, follow that too" ("the model will handle call to api endpoint",
// the user, 3 Nov). The user also lets one go by hand, with Unfollow on its card in the chat, which makes the same call
// ("i need manual mechanism", the user, 5 Nov).

const SLACK_LINK = /^https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(\S*))?$/;
const GMAIL_LINK = /^https:\/\/mail\.google\.com\/mail\/u\/\d+\/#[\w-]+\/([0-9a-f]{16})$/; // as desk writes one (mail.ts, notice)

export class Refused extends Error {}

// A Slack channel's kind, and whether the user is in it: from Slack, else guessed from what desk wrote down, a DM's id
// starting with D and a group DM's thread having no ts.
async function channelKind(channel: string): Promise<{ kind: string; member: boolean }> {
  if (CONNECT) {
    try {
      return await slack.channelOf(channel);
    } catch (e) {
      console.error(`threads: reading a Slack channel, ${(e as Error).message}`);
    }
  }
  if (channel.startsWith("D") || (await notices.ofThread(`slack:${channel}`)).length) return { kind: "dm", member: true };
  return { kind: "channel", member: true };
}

// desk's id for the thread given: its id as given, or read from its link, a Slack message's, which names its thread, or
// one of desk's own to a mail. A channel's thread is slack:<channel>:<its first message's ts>, a DM's or group DM's the
// whole DM, slack:<channel>, and a mail thread mail:<Gmail's thread id>. Attaching refuses a Slack channel the user is
// not in, whose messages desk never hears.
export async function idOf(given: string, attaching: boolean): Promise<string> {
  const text = given.trim(), slackLink = text.match(SLACK_LINK), mailLink = text.match(GMAIL_LINK);
  if (mailLink) {
    const id = `mail:${mailLink[1]}`;
    if (CONNECT) {
      try {
        return await mail.threadOf(mailLink[1]);
      } catch (e) {
        console.error(`threads: reading a mail's thread, ${(e as Error).message}`);
      }
    }
    return (await notices.threadOf(id)) ?? id; // a thread's first mail has the thread's id
  }
  if (text.startsWith("mail:") && IS.test(text)) return text;
  let channel = "", ts = "";
  if (slackLink) [channel, ts] = [slackLink[1], new URLSearchParams(slackLink[4] ?? "").get("thread_ts") ?? `${slackLink[2]}.${slackLink[3]}`];
  else if (text.startsWith("slack:") && IS.test(text)) [, channel, ts = ""] = text.split(":");
  else throw new Refused("Give the thread’s Slack link, desk’s Gmail link to one of its mails, or desk’s id for it: slack:<channel>:<ts> for a channel’s thread, slack:<channel> for a DM, mail:<thread id>.");
  const { kind, member } = await channelKind(channel);
  if (attaching && !member) throw new Refused("The user is not in that Slack channel, and desk hears only theirs: ask them to join it in Slack, then attach the thread again.");
  if (kind !== "channel") return `slack:${channel}`;
  if (!ts) throw new Refused("A channel is followed a thread at a time: give the thread’s link, or slack:<channel>:<its first message’s ts>.");
  return `slack:${channel}:${ts}`;
}

// ---- Read in desk, read in Slack

// The Slack threads Inbox rows showed you, read in Slack too as the rows turn read (inbox.ts, onRead; slack.ts,
// markRead): a thread's own row shows its notices, all but the dropped ones, and a chat's row the threads the chat
// follows, whose messages its wakes drew in the chat as cards, so only those a wake carried. A mail stays unread in
// Gmail, whose login desk holds to read only. Each thread once at a time, in order, so that two reads in a row never
// move one mark twice at once.
let marking = Promise.resolve();

export function seen(rows: inbox.Row[]) {
  const wanted = new Map<string, boolean>(); // each thread, and whether its own row showed it, whole, in its pane
  for (const r of rows) {
    if (r.id.startsWith("slack:")) wanted.set(r.id, true);
    else for (const t of chats.agentChatOf(r.session)?.threads ?? []) if (t.startsWith("slack:") && !wanted.has(t)) wanted.set(t, false);
  }
  for (const [thread, whole] of wanted) {
    marking = marking.then(() => markRead(thread, whole)).catch((e) => console.error(`threads: marking a Slack thread read, ${(e as Error).message}`));
  }
}

async function markRead(thread: string, whole: boolean) {
  const shown = (await notices.ofThread(thread)).filter((n) => n.source === "slack" && (n.chat == null || n.wake != null));
  if (!shown.length) return;
  if (!CONNECT) {
    // A test desk connects to nothing: it says what it would mark, by ids only, as a thread's words stay out of the log
    console.log(`threads: would mark ${thread} read in Slack over ${shown.length} shown${whole ? " and the thread up to it" : ""}, the newest ${shown[shown.length - 1].id}`);
    return;
  }
  await slack.markRead(thread, new Set(shown.map((n) => n.id)), whole);
}
