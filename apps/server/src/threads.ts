// A chat from a Slack thread's, DM's or mail thread's Inbox row (pages.ts, threadRow): writing in the open row starts a
// chat with Claude on it, which carries the thread whole, and only the user sees ("a layer in desk handles noti
// filtering, that only when sth worth notified about that it pops up and carry it on with me", the user, 2 Nov; the
// desk issue "desk as my notification center"). It is a Chat, Claude Code as `claude` runs from the home folder, with
// the user's skills (slack, desk, job), named after the thread; the row opens on it from then on, the thread above it.
//
// desk reads the thread again from Slack or Gmail as the chat starts, the user's own messages too, since the notices
// hold only what the door let in; the chat reads it again on GET /api/threads/<id> as the talk goes on. A desk that
// connects to nothing, a test desk, gives the notices.
import * as chats from "./chats.ts";
import { CONNECT, PORT } from "./config.ts";
import { HttpError } from "./httperror.ts";
import * as mail from "./mail.ts";
import * as notices from "./notices.ts";
import { fill, ON_THREAD } from "./prompts.ts";
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
function kindOf(n: notices.Notice) {
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
// in a block the chat's panel leaves out (transcript.ts, THREAD), so that it shows only what the user wrote.
export async function startChat(thread: string, text: string): Promise<chats.Chat> {
  if (!IS.test(thread)) throw new HttpError(404, "No such thread.");
  if (!text.trim()) throw new HttpError(400, "Write something to start the chat.");
  const shown = await notices.ofThread(thread);
  if (!shown.length) throw new HttpError(404, "No such thread.");
  if (chats.ofThread(thread)) throw new HttpError(409, "This thread has a chat already.");
  const newest = shown[shown.length - 1];
  const judged = [...shown].reverse().find((n) => n.verdict === "now") ?? [...shown].reverse().find((n) => n.verdict === "later");
  const message = fill(ON_THREAD, {
    text: text.trim(), id: thread, kind: kindOf(newest), verdict: judged?.verdict ?? "later", why: judged?.why || "no reason given",
    where: newest.source === "mail" ? "Gmail" : "Slack", read: `curl -s "${BASE}/api/threads/${encodeURIComponent(thread)}"`,
    draft: `curl -s "${BASE}/api/threads/${encodeURIComponent(thread)}/draft" -X PUT --data-binary @<the file>`,
    markup: newest.source === "mail" ? "the mail's plain text, its greeting and sign-off too" : "Slack's markup: *bold*, _italic_, <url|text> for a link, and a person as @ and their name as the thread shows it",
    whom: newest.source === "mail" ? "from their Gmail to the thread's last sender, under its subject with Re:" : newest.place === "DM" || newest.place.startsWith("group DM") ? "as them, in the DM" : "as them, in the thread",
    thread: asText(await whole(thread)),
  });
  return chats.onThread(thread, titleOf(newest), message);
}
