// The card a chat opens on when desk started it from something that came in (the server's transcript.ts, Came): a
// Slack thread or DM, a mail thread, or a run of an automation with no agent. It says what "this" is in "check this out
// and fix it" wherever the chat opens, the Inbox's pane or the middle, where until 3 Nov only the Inbox showed the
// thread. It draws what Claude read, from the chat's first message: where it came from, the newest message with the
// earlier ones folded above it, and Open in Slack, Gmail or the automation ("A", the user, 3 Nov, on three mockups, over
// the whole thread and a quote on your first words; the desk issue "A chat from a Slack message, mail or event starts
// with its context, then we file the issue"). A followed thread's new messages, which woke the chat (the server's
// wakes.ts), are the same card where they came in its talk, "1 new message".
//
// A thread's card has Reply beside Open in Slack, which opens your box above the composer on its thread
// (YourReply.tsx), and what you sent there shows as a line in the talk where you sent it (RepliedLine): "next", the user,
// 3 Nov, on mockup 6 of step 1.9. Unfollow beside them lets the thread go by hand, while the chat follows it, with Undo in
// its toast: its next message goes through desk's firewall to a row of its own and wakes nothing here ("i need manual
// mechanism", the user, 5 Nov, on a thread that kept waking a chat whose job was done).
import { useLayoutEffect, useRef, useState } from "react";
import { go } from "../app/nav";
import type { Reply } from "../store/issues";
import { slackMark } from "../ui/icons";
import { toast } from "../ui/toast";
import type { Came } from "./live";
import { sent, whole } from "./time";

const ENVELOPE = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const CLOCK = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3.25l2 1.25" /></svg>;
const OUT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>;
const REPLY = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5 2.5 7 6 10.5" /><path d="M2.5 7h7a4 4 0 0 1 4 4v1.5" /></svg>;
const UNFOLLOW = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 2.5l11 11" /><path d="M5 4.3A3.5 3.5 0 0 1 11.5 6.5c0 2.2.6 3.4 1.2 4.2M10.8 12H3.3c.7-.9 1.2-2.4 1.2-5.2M6.7 14h2.6" /></svg>;
const CARET = <svg className="steps-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5l4 3.5-4 3.5z" /></svg>;

const initial = (who: string) => who.trim().slice(0, 1).toUpperCase() || "?";
const many = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The chat follows the thread, or follows it no more; the Slack and mail threads it follows come back over /api/sync.
function setFollowing(chat: string, thread: string, on: boolean) {
  return fetch(`/api/chats/${encodeURIComponent(chat)}/threads`, { method: on ? "POST" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread }) });
}

async function unfollow(chat: string, thread: string) {
  const undo = async () => {
    const res = await setFollowing(chat, thread, true);
    if (!res.ok) toast(`Could not follow it again: ${((await res.json()) as { detail?: string }).detail ?? res.status}`);
  };
  const res = await setFollowing(chat, thread, false);
  if (res.ok) toast("This chat no longer follows the thread. Its next message gets its own Inbox row.", { label: "Undo", run: undo });
  else toast(`Could not unfollow it: ${((await res.json()) as { detail?: string }).detail ?? res.status}`);
}

// at: when the chat's first message was sent, in ms, the time a run came. reply: opens your box on its thread. chat: the
// id of the chat, given only while it follows this card's thread, which shows Unfollow.
export function CameCard({ came, at, reply, chat }: { came: Came; at?: number; reply?: (thread: string) => void; chat?: string }) {
  const [open, setOpen] = useState(false);
  const run = came.source === "automation";
  const earlier = run ? 0 : came.said.length - 1;
  const shown = run || open ? came.said : came.said.slice(-1);
  const icon = run ? CLOCK : came.source === "mail" ? ENVELOPE : slackMark(12);
  const kind = run ? `Automation${at ? ` · ${sent(at)}` : ""}` : `${came.kind} · ${many(came.said.length, came.fresh ? "new message" : "message")}`;
  const where = run ? "automation" : came.source === "mail" ? "in Gmail" : "in Slack";
  const out = !came.link ? null : run ? () => go(`/automation/${came.link}`) : () => window.open(came.link, "_blank", "noopener");
  return (
    <div className="came">
      <div className="came-head">
        <span className="came-icon">{icon}</span>
        <span className="came-place">{came.name}</span>
        <span className="came-kind">{kind}</span>
        <span className="spacer" />
        {came.thread && reply && <button className="ghost came-out" type="button" title="Reply as you, in the box above the composer" onClick={() => reply(came.thread!)}>{REPLY}Reply</button>}
        {out && <button className="ghost came-out" type="button" onClick={out}>{OUT}Open {where}</button>}
        {came.thread && chat && <button className="ghost came-out" type="button" title="Stop this thread’s new messages waking this chat" onClick={() => void unfollow(chat, came.thread!)}>{UNFOLLOW}Unfollow</button>}
      </div>
      {earlier > 0 && (
        <button className={`came-more${open ? " open" : ""}`} type="button" onClick={() => setOpen(!open)}>
          {CARET}{open ? `Fold ${earlier === 1 ? "the earlier message" : `the ${earlier} earlier messages`}` : `${many(earlier, "earlier message")}`}
        </button>
      )}
      {run ? shown.map((s, n) => (
        <div className="came-said" key={n}>
          {s.who && <span className="came-from">{s.who}:</span>}
          <Folded text={s.text} className="came-text" />
        </div>
      )) : (
        <div className="thread-msgs">
          {shown.map((s, n) => (
            <div className="thread-msg" key={n}>
              <span className="thread-avatar">{initial(s.who)}</span>
              <div className="thread-body">
                <div className="thread-meta">
                  <span className="thread-who">{s.who}</span>
                  <time className="thread-at" title={whole(s.at * 1000)}>{sent(s.at * 1000)}</time>
                </div>
                <Folded text={s.text} className="thread-text" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// What you sent from your box to a thread this chat follows, where you sent it in the talk: "You replied in #imagenhub,
// in minhnt’s thread · 11:45", your text under it, and Open in Slack once it went. Claude hears of it the next time it
// reads the thread, as of your own messages in Slack: it wakes nothing.
export function RepliedLine({ reply }: { reply: Reply }) {
  const at = (reply.sent ?? reply.at) * 1000;
  const where = reply.source === "mail" ? "Gmail" : "Slack";
  return (
    <div className="replied">
      <div className="replied-head">
        <span className="replied-icon">{reply.source === "mail" ? ENVELOPE : slackMark(12)}</span>
        <span className="replied-what"><b>You replied</b> {reply.whom}</span>
        <time className="replied-at" title={whole(at)}>· {sent(at)}</time>
        {reply.state === "kept" && <span className="replied-at">· kept, a test desk sends nothing</span>}
        <span className="spacer" />
        {reply.link && <button className="ghost came-out" type="button" onClick={() => window.open(reply.link, "_blank", "noopener")}>{OUT}Open in {where}</button>}
      </div>
      <Folded text={reply.text} className="replied-text" />
    </div>
  );
}

// A message folded at four lines with Show more, as your own long messages fold in the chat.
function Folded({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!all) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, all]);
  return (
    <>
      <div ref={ref} className={`${className}${all ? "" : " came-fold"}`}>{text}</div>
      {long && <button className="you-more came-show" type="button" onClick={() => setAll(!all)}>{all ? "Show less" : "Show more"}</button>}
    </>
  );
}
